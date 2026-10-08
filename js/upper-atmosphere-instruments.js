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
import { layerForAltitude, ATMOSPHERIC_LAYER_SCHEMA } from './upper-atmosphere-layers.js';
import { OPS_BANDS, OPS_EDGES_KM, hexCss as opsHex } from './upper-atmosphere-ops-bands.js';

const RULER_ALTS = [100, 200, 400, 800, 1200, 2000];
// The limb scale's candidate ticks (labels are thinned to a minimum spacing),
// and the layer boundaries it colours between.
const LIMB_ALTS = [50, 60, 70, 80, 85, 90, 100, 120, 150, 200, 250, 300, 400, 500, 600, 800, 1000, 1200, 1500, 2000];
const LAYER_EDGES = [...new Set(ATMOSPHERIC_LAYER_SCHEMA.flatMap((L) => [L.minKm, L.maxKm]))].sort((a, b) => a - b);

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
        // centre in canvas coordinates (+x right, +y DOWN). It is CHOSEN per
        // frame from four candidates by how much live chrome the ruler's
        // run would cross (the camera dock top-right, the explore column
        // left, the toolbar bottom-left, the time dock bottom), with
        // hysteresis so it does not flicker between equals. 20° (right and
        // a little down) is first: it lands between the readout and the
        // dock, where nothing else lives.
        this._rulerBearingRad = 20 * Math.PI / 180;
        this._rulerCands = [20, 160, 340, 200].map(d => d * Math.PI / 180);
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
        // A limb view (the camera rig's layer lens) has the planet's centre
        // far off-screen: the disc ruler would hang off the canvas, so read
        // the TANGENT heights instead.
        const c = geo?.centre;
        if (!c || c.x < -this._w || c.x > 2 * this._w || c.y < -this._h || c.y > 2 * this._h) {
            this._drawLimbScale(ctx);
            return;
        }
        if (!geo.ticks?.length) return;
        const { centre, ticks, surfaceRadius } = geo;

        const brg = this._rulerBearingRad = this._pickRulerBearing(geo);
        const ux = Math.cos(brg), uy = Math.sin(brg);
        const at = (r) => ({ x: centre.x + ux * r, y: centre.y + uy * r });

        ctx.save();
        this._drawOpsBands(ctx, at, ux, uy);
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

    /**
     * Which way the ruler hangs: the candidate bearing whose run (surface →
     * outer tick, plus label room) crosses the least chrome. Ties keep the
     * current bearing. A run entirely off-canvas scores as fully covered.
     */
    _pickRulerBearing(geo) {
        const { centre, ticks, surfaceRadius } = geo;
        const r0 = Number.isFinite(surfaceRadius) ? surfaceRadius : 0;
        const r1 = (ticks[ticks.length - 1]?.screenRadius ?? r0) + 70;
        const rects = this._avoidRects();
        const score = (brg) => {
            const ux = Math.cos(brg), uy = Math.sin(brg);
            let cost = 0, n = 0;
            for (let r = r0; r <= r1; r += 8) {
                const x = centre.x + ux * r, y = centre.y + uy * r;
                n++;
                if (x < 0 || x > this._w || y < 0 || y > this._h) { cost++; continue; }
                if (rects.some(q => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h)) cost++;
            }
            return n ? cost / n : 1;
        };
        let best = this._rulerBearingRad, bestCost = score(best);
        for (const c of this._rulerCands) {
            const k = score(c);
            if (k < bestCost - 0.05) { best = c; bestCost = k; }
        }
        return best;
    }

    /**
     * The OPERATIONAL BANDS along the ruler's spine (kernel table; the ring
     * pass on the canvas draws the same edges on the limb): a coloured
     * segment per band at its true radii, offset to the spine's far side so
     * the numeric ticks keep their side, named along the spine when the
     * segment is long enough to carry its label. The low bands are a few
     * pixels at whole-globe framing — their colour still matches the ring.
     */
    _drawOpsBands(ctx, at, ux, uy) {
        if (!this._globe.getOpsBandsVisible?.()) return;
        const geo = this._globe.limbTicks?.(OPS_EDGES_KM);
        if (!geo?.ticks?.length) return;
        const rOf = new Map(geo.ticks.map(t => [t.altKm, t.screenRadius]));
        // Perpendicular, away from the side the tick labels use.
        const px = -uy, py = ux;
        const off = 7;
        ctx.save();
        ctx.lineCap = 'butt';
        for (const b of OPS_BANDS) {
            const ra = rOf.get(b.minKm), rb = rOf.get(b.maxKm);
            if (!Number.isFinite(ra) || !Number.isFinite(rb) || rb <= ra) continue;
            const a = at(ra), c = at(rb);
            const col = opsHex(b.colorHex);
            ctx.strokeStyle = col;
            ctx.globalAlpha = 0.85;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(a.x + px * off, a.y + py * off);
            ctx.lineTo(c.x + px * off, c.y + py * off);
            ctx.stroke();
            const len = rb - ra;
            ctx.font = '700 8.5px ui-monospace, SFMono-Regular, Menlo, monospace';
            const tw = ctx.measureText(b.short).width;
            if (len < tw + 8) continue;
            const mx = (a.x + c.x) / 2 + px * (off + 9), my = (a.y + c.y) / 2 + py * (off + 9);
            ctx.save();
            ctx.translate(mx, my);
            // Text runs along the spine, never upside down.
            let ang = Math.atan2(uy, ux);
            if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI;
            ctx.rotate(ang);
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillStyle = col; ctx.globalAlpha = 0.95;
            ctx.fillText(b.short, 0, 0);
            ctx.restore();
        }
        ctx.restore();
    }

    /**
     * The limb scale: the ATMOSPHERIC LAYERS as coloured bands between their
     * boundaries' tangent points, with altitude ticks, hung on the limb at
     * screen-left. Labels are thinned to a measured spacing; the ticks and
     * bands stay where the geometry puts them (the ruler rule above).
     */
    _drawLimbScale(ctx) {
        const g = this._globe.limbTangentTicks?.([...LAYER_EDGES, ...LIMB_ALTS]);
        if (!g?.length) return;
        const at = new Map(g.map((t) => [t.altKm, t]));
        const onScreen = (t) => t && t.y > -40 && t.y < this._h + 40 && t.x > -40 && t.x < this._w + 40;
        ctx.save();
        // Layer bands.
        for (const L of ATMOSPHERIC_LAYER_SCHEMA) {
            const a = at.get(L.minKm), b = at.get(L.maxKm);
            if (!a || !b || (!onScreen(a) && !onScreen(b))) continue;
            const col = `#${L.colorHigh.toString(16).padStart(6, '0')}`;
            ctx.strokeStyle = col;
            ctx.globalAlpha = 0.85;
            ctx.lineWidth = 4;
            ctx.beginPath(); ctx.moveTo(a.x - 14, a.y); ctx.lineTo(b.x - 14, b.y); ctx.stroke();
            const span = Math.abs(a.y - b.y);
            if (span > 16) {
                const my = Math.min(Math.max((a.y + b.y) / 2, 12), this._h - 12);
                ctx.save();
                ctx.translate((a.x + b.x) / 2 - 22, my);
                ctx.rotate(-Math.PI / 2);
                ctx.font = '600 9px system-ui, sans-serif';
                ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.fillStyle = col; ctx.globalAlpha = 0.95;
                ctx.fillText(span > 90 ? L.name : L.name.replace('Thermosphere', 'Thermo.').replace('Exosphere', 'Exo.'), 0, 0);
                ctx.restore();
            }
        }
        // Altitude ticks, labels thinned to a minimum vertical spacing.
        ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
        let lastY = Infinity;
        for (const alt of LIMB_ALTS) {
            const t = at.get(alt);
            if (!onScreen(t)) continue;
            const layer = layerForAltitude(alt);
            const col = layer ? `#${layer.colorHigh.toString(16).padStart(6, '0')}` : CSS.accent;
            ctx.strokeStyle = col; ctx.globalAlpha = 0.8; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(t.x - 10, t.y); ctx.lineTo(t.x + 6, t.y); ctx.stroke();
            if (Math.abs(lastY - t.y) < 13) continue;
            lastY = t.y;
            ctx.fillStyle = col; ctx.globalAlpha = 0.95;
            ctx.fillText(`${alt} km`, t.x + 9, t.y);
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
            // What shapes the red line here — the SAME kernel and drivers the
            // shader reads (upper-atmosphere-airglow-field.js via the globe).
            airglowField: this._globe.airglowFieldAt?.(ray.point) ?? null,
            // How thick the plasma is here — the kernel the plasma view reads
            // (upper-atmosphere-plasma-field.js via the globe).
            plasmaField: this._globe.plasmaFieldAt?.(ray.point) ?? null,
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
        const H = 202 + ((pr.aboveModel || pr.sampleAlt <= 120) ? 12 : 0)
            + (pr.airglowField ? 13 : 0) + (pr.plasmaField ? 26 : 0);
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
        if (pr.airglowField) {
            // The red line's multiplier at 250 km over the plain nightglow.
            const af = pr.airglowField;
            row('630 nm here', `${af.regime} · ×${af.red250 < 10 ? af.red250.toFixed(2) : af.red250.toFixed(0)}`,
                af.regime === 'plasma bubble' ? CSS.accent : af.regime === 'nightglow' ? CSS.ink : CSS.warn);
        }
        if (pr.plasmaField) {
            // Vertical TEC over the page's 80–2000 km band (no plasmasphere),
            // and the F2 peak — the plasma view integrates the same field.
            const pf = pr.plasmaField;
            row('vTEC · NmF2', `${pf.vtecTecu.toFixed(1)} TECU · ${(pf.NmF2 / 1e11).toFixed(1)}e11 m⁻³`);
            row('plasma', `${pf.regime} · hmF2 ${Math.round(pf.hmF2)} km`,
                pf.regime === 'quiet F region' ? CSS.ink : CSS.warn);
        }

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
                     '#ua-time-dock', '#ua-time-scrubber-host', '#ua-explore-gauge', '#ua-flight-deck'];
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
        // Above the time dock, whose height the page publishes (measured,
        // never a constant) as --ua-atmo-floor on the host.
        const floor = parseFloat(getComputedStyle(this._host).getPropertyValue('--ua-atmo-floor')) || 74;
        const cx = this._w - R - 22, cy = this._h - R - floor - 14;

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
            ['630 nm', 'dayglow ~20× the nightglow where 250 km is SUNLIT (past the ground '
                     + 'terminator); at night, equatorial arcs + plasma bubbles from the '
                     + 'shared fountain model, SAR arcs on the teardrop plasmapause above Kp 4'],
            ['ripples', 'gravity-wave ripples in the green/OH band are SYMBOLIC — a fixed '
                      + 'wave set at observed wavelengths, not a wave forecast'],
            ['TIDs', 'travelling ionospheric disturbances ripple the 630 nm line: storm-time '
                   + 'waves running equatorward from the auroral oval above Kp 3, and night '
                   + 'bands drifting south-west (north-west in the south) — ILLUSTRATIVE, '
                   + 'observed speeds and wavelengths, not a TID forecast'],
            ['exposure', 'dayglow and nightglow share one log stretch — no single camera '
                       + 'exposure could record both'],
            ['not visible', 'the density render is DATA — above 80 km the neutral '
                          + 'atmosphere emits no visible light. The airglow is what '
                          + 'an eye would see.'],
            ['field', 'Jacchia-71 diurnal bulge (peaks ~14 h LST) + auroral Joule '
                    + 'heating, both area-mean-preserving'],
        ],
    };
}

/**
 * Legend copy for the plasma (slant-TEC) view. `iono` is the globe's
 * ionosphereState() (E-field + penetration), or null before it has run.
 */
export function plasmaLegend(iono = null) {
    const e = iono?.efield;
    const drive = e
        ? `shielded ${e.A_sh.toFixed(2)} kV/R_E² · penetration ΔA ${e.dA >= 0 ? '+' : ''}${e.dA.toFixed(2)}`
            + (Number.isFinite(iono.vbs) ? ` · VBs ${iono.vbs.toFixed(1)} mV/m` : '')
        : 'not running yet';
    return {
        title: 'plasma · slant TEC',
        lines: [
            ['plasma', 'colour = electrons along the view ray (slant TEC) — how thick the '
                     + 'ionosphere is in that direction, the quantity a GNSS receiver measures'],
            ['scale', 'log₁₀ over 1–1000 TECU (1 TECU = 10¹⁶ e⁻/m²) — a display transform; '
                    + 'the probe prints vertical TEC'],
            ['band', 'integrated over 80–2000 km only: real GNSS TEC also counts the '
                   + 'plasmasphere, typically +10–30 %'],
            ['stack', 'E / F1 / F2 layers from the ring-current page’s descent model, '
                    + 'F2 day term ∝ √cos χ, F10.7-scaled'],
            ['structure', 'equatorial crests + bubbles from the shared fountain · night-side '
                        + 'trough on the teardrop plasmapause · TIDs (illustrative)'],
            ['E-field', `ring-current-efield driven by Kp + solar-wind VBs: ${drive}`],
        ],
    };
}

export { RULER_ALTS, AIRGLOW_LAYERS };
