/**
 * storm-pilot/render.js — draws a run (or the idle title backdrop) on one 2D
 * canvas. It computes no physics: every boundary, belt, dome and shadow comes
 * from the sim's own functions, so what you see is what can hurt you.
 *
 * Particles (exhaust, sparks, smoke, strike bursts) are presentation only and
 * live here, fed by the sim's G.fx events and the ship's state.
 */
import { radiiToGame, toGame, windPressure, spinRate } from './planets.js';
import { boundaryRadius, patchAngles, predictPath, deadFraction, stormAt } from './sim.js';
import { DEBRIS } from './debris.js';
import { drawShip, drawLooseWing, SHIP_ART } from './art.js';

const TAU = Math.PI * 2;

export class Renderer {
    constructor(canvas) {
        this.cv = canvas;
        this.cx = canvas.getContext('2d');
        this.parts = [];
        this.viewR = 3.3;
        this.flash = 0; this.redFlash = 0; this.shake = 0;
        let s = 12345;
        const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
        this.stars = Array.from({ length: 240 }, () => ({ x: rnd(), y: rnd(), z: rnd() }));
        this.wind = Array.from({ length: 150 }, () => ({ x: rnd() * 2 - 1, y: rnd() * 2 - 1, s: 0.5 + rnd() }));
        this.resize();
    }

    resize() {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = this.cv.clientWidth || window.innerWidth, h = this.cv.clientHeight || window.innerHeight;
        this.W = w; this.H = h; this.dpr = dpr;
        this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr);
        this.cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    /** Feed the sim's presentation events (call once per frame, then clear G.fx). */
    consume(G) {
        for (const e of G.fx) {
            if (e.type === 'orb') this.burst(e.x, e.y, '#ffc53d', 24, 0.4);
            else if (e.type === 'strike') { this.burst(e.x, e.y, '#ffffff', 26, 0.45); this.burst(e.x, e.y, '#ff3fb4', 14, 0.35); this.shake = 1; this.redFlash = 0.55; }
            else if (e.type === 'wing') { this.burst(G.x, G.y, '#ffc53d', 30, 0.5); this.shake = 1.4; this.redFlash = 0.7; }
            else if (e.type === 'decay') this.parts.push({ x: e.x, y: e.y, vx: 0, vy: 0, life: 0.6, c: '#ffc53d', sz: 6 });
            else if (e.type === 'special') this.burst(e.x, e.y, e.key === 'repair' ? '#7dff8a' : '#3ef2ff', 22, 0.4);
            else if (e.type === 'flare') this.flash = 1;
        }
    }

    burst(x, y, c, n, sp) {
        for (let i = 0; i < n; i++) {
            const a = Math.random() * TAU, s = Math.random() * sp;
            this.parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.7, c });
        }
    }

    /* ── frame ─────────────────────────────────────────────────────────── */

    draw(G, t, dt) {
        const { cx, W, H } = this;
        const S = G.S || stormAt(G, G.t), P = G.planet;
        const rShip = Math.hypot(G.x, G.y);
        const want = Math.max(G.view, rShip + 0.45);
        this.viewR += (want - this.viewR) * Math.min(1, dt * 2);
        const scale = Math.min(W, H) / (2 * this.viewR), ox = W / 2, oy = H / 2 + 8;
        const Pt = (x, y) => [ox + x * scale, oy - y * scale];
        this.emit(G, dt);

        this.background(t, S.P);
        this.solarWind(P, S, Pt, dt);
        if (S.front != null) this.cmeFront(S.front, Pt);
        this.shadow(Pt, scale);
        this.belts(P, S, ox, oy, scale);
        this.boundary(P, S, Pt, ox, oy, scale, t);
        this.domes(G, ox, oy, scale, t);
        this.planet(P, S, ox, oy, scale, t, G.t);
        this.moons(G, Pt, t);
        this.debris(G, Pt, ox, oy, scale, t);
        this.orbs(G, Pt, t);
        this.path(G, Pt);
        this.particles(Pt, dt);
        this.ship(G, Pt, t);

        // flare flash, proton static, strike flash
        this.flash = Math.max(0, this.flash - dt * 1.5);
        this.redFlash = Math.max(0, this.redFlash - dt * 1.6);
        this.shake = Math.max(0, this.shake - dt * 3);
        if (this.flash > 0) { cx.fillStyle = `rgba(255,255,255,${this.flash * 0.7})`; cx.fillRect(0, 0, W, H); }
        if (this.redFlash > 0) { cx.fillStyle = `rgba(255,63,90,${this.redFlash * 0.35})`; cx.fillRect(0, 0, W, H); }
        if (S.sep > 0.05) {
            cx.fillStyle = 'rgba(255,255,255,.7)';
            for (let i = 0; i < 70 * Math.min(1.5, S.sep); i++) cx.fillRect(Math.random() * W, Math.random() * H, 2, 1);
        }
    }

    /** Title-screen backdrop: a world turning quietly in the wind. */
    drawIdle(P, t, dt) {
        const G = { planet: P, events: [], t, view: 3.6, x: 0, y: 9, vx: 0, vy: 0 };
        const S = { P: 1 + 0.3 * Math.sin(t * 0.4), sep: 0, heat: 1, flare: 0, front: null, beltBoost: 0 };
        const scale = Math.min(this.W, this.H) / 8, ox = this.W / 2, oy = this.H / 2;
        const Pt = (x, y) => [ox + x * scale, oy - y * scale];
        this.background(t, S.P);
        this.solarWind(P, S, Pt, dt);
        this.shadow(Pt, scale);
        this.belts(P, S, ox, oy, scale);
        this.boundary(P, S, Pt, ox, oy, scale, t);
        this.domes(G, ox, oy, scale, t);
        this.planet(P, S, ox, oy, scale, t, t);
        const v = this.cx.createRadialGradient(ox, oy, 0, ox, oy, Math.max(this.W, this.H) * 0.6);   // keep the title readable
        v.addColorStop(0, 'rgba(5,3,15,.62)'); v.addColorStop(1, 'rgba(5,3,15,.2)');
        this.cx.fillStyle = v; this.cx.fillRect(0, 0, this.W, this.H);
    }

    background(t, Pp) {
        const { cx, W, H } = this;
        cx.fillStyle = '#05030f'; cx.fillRect(0, 0, W, H);
        for (const s of this.stars) { cx.fillStyle = `rgba(200,220,255,${0.2 + s.z * 0.6})`; cx.fillRect(s.x * W, s.y * H, s.z * 1.6, s.z * 1.6); }
        const sg = cx.createRadialGradient(-W * 0.1, H / 2, 0, -W * 0.1, H / 2, W * 0.55);
        const hot = Math.min(1, Math.log10(Pp) / 2);
        sg.addColorStop(0, `rgba(255,${200 - 80 * hot},${90 + 60 * hot},.45)`); sg.addColorStop(0.4, 'rgba(255,120,60,.08)'); sg.addColorStop(1, 'rgba(0,0,0,0)');
        cx.fillStyle = sg; cx.fillRect(0, 0, W, H);
    }

    solarWind(P, S, Pt, dt) {
        const { cx } = this, storm = S.P > 2;
        const speed = 0.25 + 0.08 * Math.log(S.P) + 0.1 * Math.sqrt(windPressure(P));
        cx.lineWidth = 1;
        for (const w of this.wind) {
            w.x += speed * w.s * dt; if (w.x > 1) { w.x = -1; w.y = Math.random() * 2 - 1; }
            let wx = w.x * 5.5, wy = w.y * 4;
            const r = Math.hypot(wx, wy), rb = boundaryRadius(P, Math.atan2(wy, -wx), S.P);
            if (rb && r < rb + 0.2) { const k = (rb + 0.2) / Math.max(r, 0.01); wx *= k; wy *= k; }
            else if (!rb && r < 1.08 && wx < 0) continue;                       // no field: the wind hits the planet
            const [a, b] = Pt(wx, wy);
            cx.strokeStyle = `rgba(255,${storm ? 90 : 190},${storm ? 160 : 120},${0.22 + 0.28 * w.s})`;
            cx.beginPath(); cx.moveTo(a, b); cx.lineTo(a - 10 * w.s * (1 + Math.log(S.P) / 3), b); cx.stroke();
        }
    }

    cmeFront(front, Pt) {
        const { cx, H } = this;
        const [fa] = Pt((front + 4) / 4 * 7 - 6, 0);
        const g = cx.createLinearGradient(fa - 120, 0, fa + 10, 0);
        g.addColorStop(0, 'rgba(255,63,180,0)'); g.addColorStop(1, 'rgba(255,63,180,.55)');
        cx.fillStyle = g; cx.fillRect(fa - 120, 0, 130, H);
    }

    shadow(Pt) {
        const { cx, W } = this;
        const [a, b] = Pt(0, 1), [, d] = Pt(0, -1);
        const g = cx.createLinearGradient(a, 0, W, 0);
        g.addColorStop(0, 'rgba(0,0,0,.45)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        cx.fillStyle = g; cx.fillRect(a, b, W - a, d - b);
    }

    belts(P, S, ox, oy, scale) {
        const { cx } = this;
        for (const bt of P.belts) {
            const lo = radiiToGame(bt.lo) * scale, hi = radiiToGame(bt.hi) * scale;
            const a = (bt.torus ? 0.14 : 0.08) + (bt.storm ? 0.1 * S.sep + 0.06 * S.beltBoost : 0);
            cx.beginPath(); cx.arc(ox, oy, hi, 0, TAU); cx.moveTo(ox + lo, oy); cx.arc(ox, oy, lo, 0, TAU, true);
            cx.fillStyle = `rgba(${bt.hue},${a})`; cx.fill('evenodd');
        }
    }

    boundary(P, S, Pt, ox, oy, scale, t) {
        const { cx } = this, f = P.field;
        if (f.type !== 'dipole' && f.type !== 'induced') return;
        cx.beginPath();
        for (let i = -150; i <= 150; i += 3) {
            const th = i * Math.PI / 180, rr = boundaryRadius(P, th, S.P);
            const [a, b] = Pt(-Math.cos(th) * rr, Math.sin(th) * rr);
            i === -150 ? cx.moveTo(a, b) : cx.lineTo(a, b);
        }
        const crushed = f.standoff * Math.pow(S.P, -1 / 6) <= 1;
        const col = crushed ? '#ff3f5a' : S.P > 3 ? '#ff3fb4' : f.type === 'induced' ? '#b48cff' : '#3ef2ff';
        cx.strokeStyle = col; cx.lineWidth = 2; cx.shadowColor = col; cx.shadowBlur = 14;
        if (f.type === 'induced') cx.setLineDash([8, 6]);
        cx.stroke(); cx.setLineDash([]); cx.shadowBlur = 0;
        if (crushed) {                                                   // the dayside surface is naked
            cx.beginPath(); cx.arc(ox, oy, scale * 1.02, Math.PI * 0.6, Math.PI * 1.4);
            cx.strokeStyle = `rgba(255,63,90,${0.5 + 0.4 * Math.sin(t * 10)})`; cx.lineWidth = 4; cx.stroke();
        }
    }

    domes(G, ox, oy, scale, t) {
        const { cx } = this;
        for (const p of patchAngles(G, G.t)) {
            const half = p.halfDeg * Math.PI / 180, top = p.rTop * scale;
            const a0 = -(p.ang + half), a1 = -(p.ang - half);                // canvas angles are y-down
            const g = cx.createRadialGradient(ox, oy, scale, ox, oy, top);
            g.addColorStop(0, `rgba(125,255,138,${0.18 * p.str})`); g.addColorStop(1, `rgba(62,242,255,${0.05 * p.str})`);
            cx.beginPath(); cx.arc(ox, oy, top, a0, a1); cx.arc(ox, oy, scale, a1, a0, true); cx.closePath();
            cx.fillStyle = g; cx.fill();
            cx.strokeStyle = `rgba(125,255,138,${0.45 + 0.2 * Math.sin(t * 3 + p.lonDeg)})`; cx.lineWidth = 1.5;
            cx.beginPath(); cx.arc(ox, oy, top, a0, a1); cx.stroke();
        }
    }

    planet(P, S, ox, oy, scale, t, gameT) {
        const { cx } = this, L = P.look, heat = S.heat || 1;
        if (P.atmo) {
            const thick = P.id === 'venus' ? 0.16 : P.id === 'mars' ? 0.05 : 0.07;
            const ag = cx.createRadialGradient(ox, oy, scale * 0.98, ox, oy, scale * (1 + thick + 0.05 * (heat - 1)));
            ag.addColorStop(0, `rgba(${L.glow},${0.5 + 0.15 * (heat - 1)})`); ag.addColorStop(1, `rgba(${L.glow},0)`);
            cx.fillStyle = ag; cx.beginPath(); cx.arc(ox, oy, scale * (1.3), 0, TAU); cx.fill();
        }
        if (P.thermal) {                                                 // Mercury's hot dayside
            const hg = cx.createRadialGradient(ox - scale * 0.3, oy, scale * 0.8, ox - scale * 0.3, oy, scale * 1.5);
            hg.addColorStop(0, 'rgba(255,120,40,.35)'); hg.addColorStop(1, 'rgba(255,120,40,0)');
            cx.fillStyle = hg; cx.beginPath(); cx.arc(ox, oy, scale * 1.6, Math.PI * 0.5, Math.PI * 1.5); cx.fill();
        }
        const pg = cx.createLinearGradient(ox - scale, 0, ox + scale, 0);
        pg.addColorStop(0, L.day); pg.addColorStop(0.5, L.mid); pg.addColorStop(0.56, L.night); pg.addColorStop(1, L.night);
        cx.fillStyle = pg; cx.beginPath(); cx.arc(ox, oy, scale, 0, TAU); cx.fill();
        if (L.bands) {                                                   // Jupiter's belts and zones, turning
            cx.save(); cx.beginPath(); cx.arc(ox, oy, scale, 0, TAU); cx.clip();
            for (let i = -4; i <= 4; i++) {
                cx.fillStyle = i % 2 ? 'rgba(120,60,30,.18)' : 'rgba(255,240,220,.08)';
                cx.fillRect(ox - scale, oy + i * scale * 0.2 - scale * 0.07, scale * 2, scale * 0.12);
            }
            cx.restore();
        }
        if (S.dust) {                                                    // Martian dust storm haze
            cx.fillStyle = 'rgba(255,170,110,.22)'; cx.beginPath(); cx.arc(ox, oy, scale * 1.04, 0, TAU); cx.fill();
        }
        // a meridian tick that turns with the planet, so its rotation reads
        const rot = spinRate(P) * gameT;
        cx.strokeStyle = 'rgba(255,255,255,.12)'; cx.lineWidth = 1;
        for (let k = 0; k < 6; k++) {
            const a = -rot + k * Math.PI / 3, c = Math.cos(a);
            cx.beginPath(); cx.ellipse(ox, oy, Math.abs(c) * scale, scale, 0, 0, TAU); cx.stroke();
        }
        cx.strokeStyle = `rgba(${L.glow},.6)`; cx.beginPath(); cx.arc(ox, oy, scale, 0, TAU); cx.stroke();
    }

    moons(G, Pt, t) {
        const { cx } = this;
        for (const m of G.moons || []) {
            const [a, b] = Pt(Math.cos(m.a) * m.r, Math.sin(m.a) * m.r);
            cx.save(); cx.translate(a, b);
            if (m.volcanic) {
                cx.fillStyle = '#ffd35a'; cx.shadowColor = '#ff9a3d'; cx.shadowBlur = 14;
                cx.beginPath(); cx.arc(0, 0, m.drawPx, 0, TAU); cx.fill();
                cx.fillStyle = '#b5482a'; cx.shadowBlur = 0;
                for (let k = 0; k < 4; k++) { cx.beginPath(); cx.arc(Math.cos(k * 1.7) * m.drawPx * 0.5, Math.sin(k * 2.3) * m.drawPx * 0.5, 1.5, 0, TAU); cx.fill(); }
            } else {
                cx.fillStyle = '#9a8c80'; cx.shadowColor = '#fff'; cx.shadowBlur = 6;
                cx.beginPath(); cx.ellipse(0, 0, m.drawPx, m.drawPx * 0.75, 0.6, 0, TAU); cx.fill();
            }
            cx.restore();
            cx.font = '600 10px "IBM Plex Mono", monospace'; cx.fillStyle = 'rgba(232,241,255,.6)'; cx.textAlign = 'center';
            cx.fillText(m.name.toUpperCase(), a, b - m.drawPx - 6);
        }
    }

    debris(G, Pt, ox, oy, scale, t) {
        const { cx } = this;
        G.clouds.forEach((key, i) => {
            const D = DEBRIS[key], rr = toGame(G.planet, D.altKm) * scale;
            cx.setLineDash([2, 10]); cx.strokeStyle = 'rgba(255,90,90,.28)'; cx.lineWidth = 1;
            cx.beginPath(); cx.arc(ox, oy, rr, 0, TAU); cx.stroke(); cx.setLineDash([]);
            cx.font = '600 10px "IBM Plex Mono", monospace'; cx.fillStyle = 'rgba(255,120,120,.75)'; cx.textAlign = 'center';
            // alternate labels below / above their rings so neighbouring clouds never overprint
            cx.fillText(`${D.name.toUpperCase()} DEBRIS · ${D.year} · ${D.altKm.toLocaleString()} km`, ox, i % 2 ? oy - rr - 6 : oy + rr + 13);
        });
        for (const f of G.frags) {
            const [a, b] = Pt(f.x, f.y);
            if (f.wing) { cx.save(); cx.translate(a, b); drawLooseWing(cx, f.spin, SHIP_ART[f.ship].flight * 0.9, t); cx.restore(); continue; }
            const z = f.sz, retro = (f.x * f.vy - f.y * f.vx) > 0;
            if (retro) {
                const [ta, tb] = Pt(f.x - f.vx * 0.12, f.y - f.vy * 0.12);
                cx.strokeStyle = 'rgba(255,80,80,.35)'; cx.lineWidth = 1; cx.beginPath(); cx.moveTo(a, b); cx.lineTo(ta, tb); cx.stroke();
            }
            cx.save(); cx.translate(a, b); cx.rotate(f.spin);
            cx.shadowColor = '#ff5a5a'; cx.shadowBlur = 6; cx.fillStyle = f.seed < 0.3 ? '#ffb0b0' : '#cfd6e6';
            cx.beginPath(); cx.moveTo(z, 0); cx.lineTo(-z * 0.6, z * 0.7); cx.lineTo(-z * 0.3, -z * 0.2); cx.lineTo(-z * 0.5, -z * 0.9); cx.closePath(); cx.fill();
            cx.restore();
        }
        if (G.conj) {                                                    // conjunction reticle + line to the ship
            const [a, b] = Pt(G.conj.f.x, G.conj.f.y), [sa, sb] = Pt(G.x, G.y), q = 9 + Math.sin(t * 14) * 2;
            cx.strokeStyle = '#ff3f5a'; cx.shadowColor = '#ff3f5a'; cx.shadowBlur = 10; cx.lineWidth = 1.5;
            cx.beginPath();
            for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
                cx.moveTo(a + sx * q, b + sy * q * 0.45); cx.lineTo(a + sx * q, b + sy * q); cx.lineTo(a + sx * q * 0.45, b + sy * q);
            }
            cx.stroke(); cx.setLineDash([4, 4]); cx.beginPath(); cx.moveTo(a, b); cx.lineTo(sa, sb); cx.stroke(); cx.setLineDash([]); cx.shadowBlur = 0;
        }
    }

    orbs(G, Pt, t) {
        const { cx } = this;
        for (const o of G.orbs) {
            const [a, b] = Pt(Math.cos(o.a) * o.r, Math.sin(o.a) * o.r), s = 7 + Math.sin(t * 5 + o.r * 9) * 1.5;
            cx.save(); cx.translate(a, b); cx.rotate(Math.PI / 4 + t);
            cx.shadowColor = '#ffc53d'; cx.shadowBlur = 16; cx.strokeStyle = '#ffc53d'; cx.lineWidth = 2;
            cx.strokeRect(-s / 2, -s / 2, s, s); cx.fillStyle = 'rgba(255,197,61,.25)'; cx.fillRect(-s / 4, -s / 4, s / 2, s / 2);
            cx.restore();
        }
    }

    path(G, Pt) {
        const { cx } = this, pr = predictPath(G);
        cx.setLineDash([3, 6]); cx.strokeStyle = pr.crash ? '#ff3fb4' : 'rgba(62,242,255,.7)'; cx.lineWidth = 1.5;
        cx.beginPath(); let [a, b] = Pt(G.x, G.y); cx.moveTo(a, b);
        for (let i = 0; i < pr.pts.length; i += 2) { [a, b] = Pt(pr.pts[i], pr.pts[i + 1]); cx.lineTo(a, b); }
        cx.stroke(); cx.setLineDash([]);
    }

    emit(G, dt) {
        const dmg = 1 - G.hull / G.ship.hull, back = G.ang + Math.PI;
        if (G.thrusting && Math.random() < 0.3) {
            const sp = G.boosting ? 0.35 : 0.22, a = back + (Math.random() - 0.5) * 0.5;
            this.parts.push({ x: G.x, y: G.y, vx: G.vx + Math.cos(a) * sp, vy: G.vy + Math.sin(a) * sp, life: 0.45, c: G.ship.ion ? '#9b8cff' : '#ff3fb4' });
        }
        if (G.rate > 1.5 && Math.random() < 0.3) this.parts.push({ x: G.x, y: G.y, vx: G.vx + (Math.random() - 0.5) * 0.3, vy: G.vy + (Math.random() - 0.5) * 0.3, life: 0.4, c: '#fff' });
        if (Math.random() < dmg * dmg * 0.9) this.parts.push({ x: G.x, y: G.y, vx: G.vx + (Math.random() - 0.5) * 0.25, vy: G.vy + (Math.random() - 0.5) * 0.25, life: 0.35, c: Math.random() < 0.5 ? '#ffc53d' : '#fff', sz: 2 });
        if (dmg > 0.55 && Math.random() < (dmg - 0.5) * 0.8) this.parts.push({ x: G.x, y: G.y, vx: G.vx * 0.96, vy: G.vy * 0.96, life: 1.2, c: 'rgba(160,160,180,.5)', sz: 6, smoke: true });
        if ((!G.wings.neg || !G.wings.pos) && Math.random() < 0.15) this.parts.push({ x: G.x, y: G.y, vx: G.vx + (Math.random() - 0.5) * 0.2, vy: G.vy + (Math.random() - 0.5) * 0.2, life: 0.3, c: '#ffc53d', sz: 2 });
    }

    particles(Pt, dt) {
        const { cx } = this;
        for (const p of this.parts) {
            p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
            const [a, b] = Pt(p.x, p.y), z = p.sz || 3;
            cx.globalAlpha = Math.max(0, p.smoke ? p.life * 0.6 : p.life * 2); cx.fillStyle = p.c;
            if (p.smoke) { cx.beginPath(); cx.arc(a, b, z * (1.6 - p.life), 0, TAU); cx.fill(); } else cx.fillRect(a - z / 2, b - z / 2, z, z);
        }
        cx.globalAlpha = 1;
        this.parts = this.parts.filter((p) => p.life > 0);
        if (this.parts.length > 900) this.parts.splice(0, this.parts.length - 900);
    }

    ship(G, Pt, t) {
        const { cx } = this, art = SHIP_ART[G.ship.id];
        const [sx, sy] = Pt(G.x, G.y);
        cx.save(); cx.translate(sx + (Math.random() - 0.5) * 8 * this.shake, sy + (Math.random() - 0.5) * 8 * this.shake);
        const shR = art.R * art.flight + 6;
        if (G.shield || G.faraday > 0) {
            cx.beginPath(); cx.arc(0, 0, shR, 0, TAU); cx.strokeStyle = G.faraday > 0 ? '#ffc53d' : '#ff3fb4';
            cx.shadowColor = cx.strokeStyle; cx.shadowBlur = 16; cx.lineWidth = 2; cx.stroke(); cx.shadowBlur = 0;
        }
        const dmg = 1 - G.hull / G.ship.hull;
        drawShip(cx, G.ship.id, {
            ang: -G.ang, t, thrust: G.thrusting, boost: G.boosting,
            hot: (G.rate > 1.5 || this.shake > 0.5) && Math.floor(t * 12) % 2 ? '#ffffff' : (dmg > 0.7 && Math.random() < 0.08 ? '#ff3f5a' : null),
            dmg, cells: deadFraction(G), lit: G.ex?.shadow ? 0 : G.track,
            ww: (1 - G.fold) * (0.4 + 0.6 * G.track) + G.fold * 0.25, wl: 1 - 0.8 * G.fold,
            lost: { neg: !G.wings.neg, pos: !G.wings.pos },
        });
        cx.restore();
    }
}
