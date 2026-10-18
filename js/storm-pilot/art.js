/**
 * storm-pilot/art.js — the satellites, drawn as neon vector art on a 2D canvas.
 *
 * Each ship is modelled on its real class (6U CubeSat, hexagonal SmallSat,
 * armoured GEO bus, long-winged ion explorer). Nose along +x, wings along ±y in
 * the ship's own frame; `drawShip` turns and scales the frame.
 *
 * Wings carry three kinds of state:
 *   · TRACKING  — wings turn on their booms, so from above they narrow (ww) and
 *                 dim (lit) as the Sun moves off the nose; folded for shield mode
 *                 they retract toward the bus (wl).
 *   · DAMAGE    — dead cells (cells = fraction) are picked by a fixed per-cell
 *                 hash, so damage ACCUMULATES instead of flickering; scorch marks
 *                 and an arcing harness grow with dmg.
 *   · LOSS      — lost.neg / lost.pos removes a whole wing and leaves a snapped
 *                 boom stub. A lost wing tumbles away as debris (`drawLooseWing`).
 */
export const NEON = { cyan: '#3ef2ff', mag: '#ff3fb4', amb: '#ffc53d', lime: '#7dff8a', ion: '#9b8cff', white: '#e8f1ff' };
function line(c, col, w, blur = 8) { c.strokeStyle = col; c.lineWidth = w; c.shadowColor = col; c.shadowBlur = blur; }
function poly(c, pts) { c.beginPath(); pts.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y)); c.closePath(); }
// A solar wing: dark-blue cells on a cyan grid, with a glint that sweeps along it.
function wing(c, x0, y0, w, h, cols, rows, o, phase = 0) {
  if (o.lost && (y0 + h / 2 < 0 ? o.lost.neg : o.lost.pos)) return;
  const k = o.k, mid = x0 + w / 2, lit = o.lit;
  c.save();
  // Tracking: the wing turns on its boom, so from above it narrows (ww) and,
  // folded for shield mode, it retracts toward the bus (wl).
  c.translate(mid, 0); c.scale(o.ww, o.wl); c.translate(-mid, 0);
  const g = c.createLinearGradient(x0, y0, x0 + w, y0 + h), b = .35 + .65 * lit;
  g.addColorStop(0, `rgba(${40 * b + 10},${60 * b + 10},${190 * b + 30},.88)`); g.addColorStop(1, `rgba(${20 * b},${24 * b},${90 * b + 20},.88)`);
  c.fillStyle = g; c.shadowBlur = 0; c.fillRect(x0, y0, w, h);
  // Dead cells: deterministic per cell, so damage accumulates instead of flickering.
  if (o.cells > 0) for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
    const hsh = Math.abs(Math.sin(i * 12.9898 + j * 78.233 + phase * 37.71 + x0 * 3.1 + y0 * 1.7) * 43758.5453) % 1;
    if (hsh < o.cells) {
      const cx0 = x0 + w * i / cols, cy0 = y0 + h * j / rows, cw = w / cols, ch = h / rows;
      c.fillStyle = 'rgba(8,5,18,.95)'; c.fillRect(cx0, cy0, cw, ch);
      c.strokeStyle = 'rgba(255,90,90,.8)'; c.lineWidth = .6 * k; c.beginPath();
      c.moveTo(cx0 + cw * .2, cy0 + ch * .1); c.lineTo(cx0 + cw * .55, cy0 + ch * .5); c.lineTo(cx0 + cw * .4, cy0 + ch * .9); c.stroke();
    }
  }
  c.strokeStyle = 'rgba(62,242,255,.35)'; c.lineWidth = .6 * k; c.beginPath();
  for (let i = 1; i < cols; i++) { c.moveTo(x0 + w * i / cols, y0); c.lineTo(x0 + w * i / cols, y0 + h); }
  for (let j = 1; j < rows; j++) { c.moveTo(x0, y0 + h * j / rows); c.lineTo(x0 + w, y0 + h * j / rows); }
  c.stroke();
  // glint: a bright band travelling along the wing
  const s = ((o.t * .45 + phase) % 1.8) - .4;
  if (s > 0 && s < 1 && lit > .15) {
    c.beginPath(); c.rect(x0, y0, w, h); c.clip();
    const gy = y0 + h * s, gl = c.createLinearGradient(0, gy - h * .12, 0, gy + h * .12);
    gl.addColorStop(0, 'rgba(255,255,255,0)'); gl.addColorStop(.5, `rgba(190,250,255,${.6 * lit})`); gl.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = gl; c.fillRect(x0, gy - h * .12, w, h * .24);
  }
  c.restore();
  c.save(); c.translate(mid, 0); c.scale(o.ww, o.wl); c.translate(-mid, 0);
  line(c, o.hot || NEON.cyan, 1.1 * k, 8); c.strokeRect(x0, y0, w, h);
  c.restore();
}
function boom(c, x, y0, y1, o) {
  const lost = o.lost && (y1 < 0 ? o.lost.neg : o.lost.pos);
  line(c, 'rgba(232,241,255,.7)', 1 * k1(o), 0); c.beginPath(); c.moveTo(x, y0 * o.wl);
  if (!lost) { c.lineTo(x, y1 * o.wl); c.stroke(); return; }
  // snapped boom: a jagged stub that spits sparks
  const s = Math.sign(y1), ym = y0 + (y1 - y0) * .55;
  c.lineTo(x, ym); c.lineTo(x + 1.2, ym + s * 1.2); c.lineTo(x - .8, ym + s * 1.8); c.stroke();
  if (Math.floor(o.t * 14) % 3 === 0) { c.fillStyle = NEON.amb; c.shadowColor = NEON.amb; c.shadowBlur = 10; c.fillRect(x - .8, ym + s * 2, 1.6, 1.6); }
}
const k1 = (o) => o.k;
// Parabolic dish facing +x (or −x with dir = −1).
function dish(c, x, y, r, dir, o, col = NEON.mag) {
  line(c, col, 1.4 * o.k, 10);
  c.beginPath(); c.ellipse(x, y, r * .35, r, 0, dir > 0 ? -Math.PI / 2 : Math.PI / 2, dir > 0 ? Math.PI / 2 : Math.PI * 1.5); c.stroke();
  c.beginPath(); c.moveTo(x, y - r); c.lineTo(x, y + r); c.stroke();
  c.beginPath(); c.moveTo(x, y); c.lineTo(x + dir * r * .9, y); c.stroke();                    // feed
  c.beginPath(); c.arc(x + dir * r * .9, y, 1.2 * o.k, 0, 7); c.fillStyle = col; c.fill();
}
// Gold-foil (MLI) body panel with crinkle lines.
function foil(c, x, y, w, h, o, col = NEON.amb) {
  c.shadowBlur = 0; c.fillStyle = 'rgba(255,197,61,.16)'; c.fillRect(x, y, w, h);
  c.strokeStyle = 'rgba(255,197,61,.28)'; c.lineWidth = .5 * o.k; c.beginPath();
  for (let i = 1; i < 5; i++) { const yy = y + h * i / 5; c.moveTo(x, yy); c.lineTo(x + w * .3, yy + h * .06); c.lineTo(x + w * .7, yy - h * .05); c.lineTo(x + w, yy); }
  c.stroke(); line(c, col, 1.4 * o.k, 10); c.strokeRect(x, y, w, h);
}
function navLights(c, pts, o) {
  const on = Math.floor(o.t * 2.2) % 3 === 0;
  pts.forEach(([x, y], i) => { c.beginPath(); c.arc(x, y, 1.3 * o.k, 0, 7);
    c.fillStyle = on ? (i % 2 ? '#7dff8a' : '#ff3f5a') : 'rgba(255,255,255,.15)'; c.shadowColor = c.fillStyle; c.shadowBlur = on ? 10 : 0; c.fill(); });
}
// Engine plume: chemical = flickering magenta/amber cone, ion = long violet beam.
function plume(c, x, y, w, len, o, ion) {
  if (!o.thrust) return;
  const f = ion ? 1 : .75 + Math.random() * .5, L = len * f * (o.boost ? 1.6 : 1);
  const g = c.createLinearGradient(x, 0, x - L, 0);
  if (ion) { g.addColorStop(0, 'rgba(210,200,255,.95)'); g.addColorStop(.25, 'rgba(155,140,255,.6)'); g.addColorStop(1, 'rgba(155,140,255,0)'); }
  else { g.addColorStop(0, 'rgba(255,255,255,.95)'); g.addColorStop(.2, 'rgba(255,197,61,.85)'); g.addColorStop(.55, 'rgba(255,63,180,.5)'); g.addColorStop(1, 'rgba(255,63,180,0)'); }
  c.shadowColor = ion ? NEON.ion : NEON.mag; c.shadowBlur = 16; c.fillStyle = g;
  c.beginPath(); c.moveTo(x, y - w / 2); c.lineTo(x - L, y - (ion ? w * .35 : w * 1.1)); c.lineTo(x - L, y + (ion ? w * .35 : w * 1.1)); c.lineTo(x, y + w / 2); c.closePath(); c.fill();
}

export const SHIP_ART = {
  // 6U CubeSat: two 3U stacks with four deployed panels and a whip antenna.
  wren: { body: 6, R: 20, flight: 1.15, draw(c, o) {
    plume(c, -7, 0, 4, 14, o);
    wing(c, -7, -17, 6.6, 12, 2, 4, o, 0); wing(c, .4, -17, 6.6, 12, 2, 4, o, .2);
    wing(c, -7, 5, 6.6, 12, 2, 4, o, .5); wing(c, .4, 5, 6.6, 12, 2, 4, o, .7);
    foil(c, -7, -4.5, 14, 9, o, o.hot || NEON.cyan);
    line(c, o.hot || NEON.cyan, .7 * o.k, 0); c.beginPath(); c.moveTo(-2.3, -4.5); c.lineTo(-2.3, 4.5); c.moveTo(2.3, -4.5); c.lineTo(2.3, 4.5); c.moveTo(-7, 0); c.lineTo(7, 0); c.stroke();
    line(c, NEON.mag, 1 * o.k, 8); c.beginPath(); c.moveTo(7, -3); c.quadraticCurveTo(13, -5, 18, -10); c.stroke();
    c.beginPath(); c.arc(18, -10, 1.3 * o.k, 0, 7); c.fillStyle = NEON.mag; c.fill();
    line(c, NEON.white, 1 * o.k, 6); c.beginPath(); c.moveTo(-7, -2); c.lineTo(-9, -3); c.moveTo(-7, 2); c.lineTo(-9, 3); c.stroke();
    navLights(c, [[6, -4], [6, 4]], o);
  } },
  // SmallSat: hexagonal bus, single wing pair on booms, comms dish and star tracker.
  kestrel: { body: 8, R: 32, flight: .98, draw(c, o) {
    plume(c, -9, 0, 5, 18, o);
    boom(c, 0, -7, -11, o); boom(c, 0, 7, 11, o);
    wing(c, -5, -31, 10, 20, 3, 6, o, 0); wing(c, -5, 11, 10, 20, 3, 6, o, .9);
    const hex = []; for (let i = 0; i < 6; i++) hex.push([Math.cos(i * Math.PI / 3) * 9, Math.sin(i * Math.PI / 3) * 8]);
    c.save(); poly(c, hex); c.clip(); foil(c, -9, -8, 18, 16, o); c.restore();
    line(c, o.hot || NEON.cyan, 1.5 * o.k, 12); poly(c, hex); c.stroke();
    line(c, o.hot || NEON.cyan, .8 * o.k, 0); poly(c, hex.map(([x, y]) => [x * .55, y * .55])); c.stroke();
    dish(c, 10.5, 0, 6, 1, o);
    line(c, NEON.lime, 1 * o.k, 8); poly(c, [[-4, -8], [-1, -8], [-1.5, -10.5], [-3.5, -10.5]]); c.stroke();      // star tracker
    line(c, NEON.white, 1.2 * o.k, 6); poly(c, [[-9, -2], [-12, -3.5], [-12, 3.5], [-9, 2]]); c.stroke();      // nozzle
    navLights(c, [[4.5, -7], [4.5, 7]], o);
  } },
  // Rad-hard GEO bus: armoured box, two long four-panel wings, big dish, apogee engine bell.
  atlas: { body: 11, R: 54, flight: .76, draw(c, o) {
    plume(c, -18, 0, 9, 26, o);
    boom(c, 0, -10, -14, o); boom(c, 0, 10, 14, o);
    for (let i = 0; i < 4; i++) { wing(c, -6, -24 - i * 10, 12, 9.2, 3, 2, o, i * .12); wing(c, -6, 14.8 + i * 10, 12, 9.2, 3, 2, o, .9 + i * .12); }
    foil(c, -12, -10, 24, 20, o, o.hot || NEON.lime);
    // armour chevrons
    line(c, 'rgba(125,255,138,.55)', .8 * o.k, 0); c.beginPath();
    for (let x = -10; x < 10; x += 4) { c.moveTo(x, -8); c.lineTo(x + 2, -5); c.lineTo(x + 4, -8); c.moveTo(x, 8); c.lineTo(x + 2, 5); c.lineTo(x + 4, 8); }
    c.stroke();
    line(c, o.hot || NEON.lime, 1 * o.k, 0); c.strokeRect(-8, -3.5, 16, 7);
    [[-11, -9], [11, -9], [-11, 9], [11, 9]].forEach(([x, y]) => { c.beginPath(); c.arc(x, y, .9 * o.k, 0, 7); c.fillStyle = NEON.white; c.fill(); });
    dish(c, 13, -2, 10, 1, o); dish(c, 13, 7.5, 3.5, 1, o, NEON.cyan);
    line(c, NEON.white, 1.4 * o.k, 8); poly(c, [[-12, -3], [-18, -6.5], [-18, 6.5], [-12, 3]]); c.stroke();
    c.fillStyle = 'rgba(232,241,255,.12)'; c.fill();
    navLights(c, [[10, -10], [10, 10]], o);
  } },
  // Ion explorer: compact bus, very long thin wings, side dish, gridded ion thruster.
  dawn: { body: 6, R: 62, flight: .7, draw(c, o) {
    plume(c, -10, 0, 6, 46, o, true);
    boom(c, 0, -6, -9, o); boom(c, 0, 6, 9, o);
    for (let i = 0; i < 5; i++) { wing(c, -3.5, -18.6 - i * 9.6, 7, 9, 2, 2, o, i * .1); wing(c, -3.5, 9.6 + i * 9.6, 7, 9, 2, 2, o, .9 + i * .1); }
    foil(c, -7, -6, 14, 12, o, o.hot || NEON.ion);
    line(c, o.hot || NEON.ion, .8 * o.k, 0); c.beginPath(); c.moveTo(-7, -6); c.lineTo(7, 6); c.moveTo(7, -6); c.lineTo(-7, 6); c.stroke();
    dish(c, 9, 0, 7, 1, o, NEON.cyan);
    // ion thruster: gridded circle with a violet core
    c.beginPath(); c.arc(-9, 0, 3.4, 0, 7); c.fillStyle = o.thrust ? 'rgba(200,190,255,.9)' : 'rgba(155,140,255,.25)'; c.shadowColor = NEON.ion; c.shadowBlur = o.thrust ? 18 : 6; c.fill();
    line(c, NEON.ion, 1 * o.k, 8); c.beginPath(); c.arc(-9, 0, 3.4, 0, 7); c.stroke();
    line(c, 'rgba(5,3,15,.7)', .6 * o.k, 0); c.beginPath(); c.moveTo(-9, -3.4); c.lineTo(-9, 3.4); c.moveTo(-12.4, 0); c.lineTo(-5.6, 0); c.stroke();
    navLights(c, [[6, -6], [6, 6]], o);
  } },
};
// opts: { ang, scale, t, thrust, boost, hot, dmg 0–1, cells 0–1 (dead panel fraction),
//         lit 0–1 (array illumination), ww / wl (wing width / length from tracking + folding),
//         lost { neg, pos } (wings snapped off) }
export function drawShip(c, id, opts) {
  const art = SHIP_ART[id], s = opts.scale ?? art.flight;
  const o = { t: opts.t || 0, thrust: !!opts.thrust, boost: !!opts.boost, hot: opts.hot, k: 1 / s,
    dmg: opts.dmg || 0, cells: opts.cells || 0, lit: opts.lit ?? 1, ww: opts.ww ?? 1, wl: opts.wl ?? 1, lost: opts.lost || null };
  c.save(); c.rotate(opts.ang || 0); c.scale(s, s);
  art.draw(c, o);
  // scorch marks on the bus as the hull goes
  if (o.dmg > .3) {
    const n = o.dmg > .65 ? 3 : o.dmg > .45 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const a = i * 2.2 + .6, x = Math.cos(a) * art.body * .5, y = Math.sin(a) * art.body * .45, rr = art.body * (.35 + .1 * i);
      const g = c.createRadialGradient(x, y, 0, x, y, rr);
      g.addColorStop(0, 'rgba(10,6,12,.9)'); g.addColorStop(.6, 'rgba(60,20,20,.5)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      c.shadowBlur = 0; c.fillStyle = g; c.beginPath(); c.arc(x, y, rr, 0, 7); c.fill();
    }
    if (o.dmg > .6 && Math.floor(o.t * 9) % 4 === 0) {           // an exposed, arcing harness
      line(c, NEON.amb, .8 * o.k, 10); c.beginPath(); c.moveTo(-art.body * .3, -art.body * .2);
      c.lineTo(art.body * .05, art.body * .15); c.lineTo(-art.body * .1, art.body * .35); c.stroke();
    }
  }
  c.restore();
}

/** A snapped-off wing, tumbling as debris. Drawn at the fragment's own spin. */
export function drawLooseWing(c, ang, scale, t) {
  const o = { t, k: 1 / scale, lit: .5, ww: 1, wl: 1, cells: .35, lost: null };
  c.save(); c.rotate(ang); c.scale(scale, scale);
  wing(c, -4, -9, 8, 18, 2, 4, o, .3);
  line(c, 'rgba(232,241,255,.7)', 1 * o.k, 0); c.beginPath(); c.moveTo(0, 9); c.lineTo(.8, 12); c.stroke();
  c.restore();
}
