/**
 * chicxulub-page.js — chicxulub.html's renderer.
 * Draws ONLY what js/chicxulub/{observations,impact-model,reconstruct}.js
 * return; it computes no physics (unit conversions for display only).
 * Colours: the validated dark categorical slots 1–3 (blue / orange / aqua,
 * all-pairs CVD ΔE ≥ 9.4 on #0a0e1e); "no bound orbit" is a neutral, because
 * it is the absence of a class. One hue (blue) carries probability.
 */
import * as O from './chicxulub/observations.js';
import * as M from './chicxulub/impact-model.js';
import * as R from './chicxulub/reconstruct.js';

const $ = (id) => document.getElementById(id);
const INK = '#f3f5ff', INK2 = '#aab3cb', MUTED = '#8a93ad', GRID = 'rgba(255,255,255,.08)', SURFACE = '#0a0e1e';
const BLUE = '#3987e5', ORANGE = '#d95926', AQUA = '#199e70', NONE = '#2a3046';
const CLASS = Object.freeze({
    asteroidal: { color: BLUE, label: 'asteroid-like orbit' },
    'jupiter-family-like': { color: AQUA, label: 'Jupiter-family-comet-like' },
    'long-period-like': { color: ORANGE, label: 'long-period or retrograde' },
    retrograde: { color: ORANGE, label: 'long-period or retrograde' },
    unbound: { color: NONE, label: 'no bound orbit (ruled out)' },
});
const LAT = O.CRATER.centre.latDeg, LON = O.CRATER.centre.lonDeg;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fx = (x, d = 1) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(d));
const sci = (x) => { if (!(x > 0)) return '—'; const e = Math.floor(Math.log10(x)); return `${(x / 10 ** e).toFixed(1)}×10${String(e).replace(/-/g, '⁻').replace(/\d/g, (d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[d])}`; };
const range = (q, d = 0, s = 1) => `${fx(q.lo * s, d)}–${fx(q.hi * s, d)}`;
const clock = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${h % 1 ? '30' : '00'}`;
function dur(s) {
    if (s == null || !Number.isFinite(s)) return '—';
    if (s < 90) return `${Math.round(s)} s`;
    if (s < 5400) return `${Math.round(s / 60)} min`;
    if (s < 172800) return `${(s / 3600).toFixed(1)} h`;
    return `${(s / 86400).toFixed(1)} days`;
}

// ── tooltip (one element, text only) ────────────────────────────────────────
const tip = $('chx-tip');
function showTip(text, x, y) {
    tip.textContent = text; tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = `${Math.max(6, Math.min(innerWidth - w - 6, x + 14))}px`;
    tip.style.top = `${Math.max(6, y - h - 12 < 6 ? y + 16 : y - h - 12)}px`;
}
document.addEventListener('pointermove', (e) => {
    const t = e.target.closest?.('[data-tip]');
    if (t) showTip(t.dataset.tip, e.clientX, e.clientY); else if (!e.target.closest?.('canvas')) tip.hidden = true;
});
document.addEventListener('pointerleave', () => { tip.hidden = true; });

function segmented(id, onPick) {
    const el = $(id);
    el.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        for (const x of el.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
        onPick(b.dataset.v);
    });
}

// ── state ───────────────────────────────────────────────────────────────────
const cache = new Map();
function posterior(scenario, craterKm) {
    const key = `${scenario}|${craterKm}`;
    if (!cache.has(key)) cache.set(key, R.reconstructImpactor({ scenario, craterKm }));
    return cache.get(key);
}
const S = { scenario: 'asteroid', craterKm: 155 };
const base = posterior('asteroid', 155);
const FWD = M.forward({ diameterKm: base.diameterKm.med, speedKms: base.speedKms.med, angleDeg: base.angleDeg.med, density: base.density.med, fDep: base.fDep.med });

// ── hero ────────────────────────────────────────────────────────────────────
function renderTiles() {
    const t = (big, label, sub) => `<div class="chx-tile"><b>${big}</b><span>${label}</span><i>${sub}</i></div>`;
    $('chx-tiles').innerHTML = [
        t(`${fx(base.diameterKm.med, 0)} km`, 'asteroid diameter', `${range(base.diameterKm)} km`),
        t(`${fx(base.speedKms.med, 0)} km/s`, 'speed at the ground', `${range(base.speedKms)} km/s`),
        t(`${sci(base.massKg.med)} kg`, 'mass', `${sci(base.massKg.lo)} – ${sci(base.massKg.hi)}`),
        t(`${sci(base.energyJ.med)} J`, 'energy released', `${fx(base.energyJ.med / M.J_PER_MT / 1e6, 0)} million megatons`),
        t(`${range(base.angleDeg)}°`, 'angle above the horizon', 'from the north-east (published)'),
        t(`${fx(FWD.seismicM, 1)}`, 'earthquake magnitude', `published range ${O.ENERGY.seismicMw.lo}–${O.ENERGY.seismicMw.hi}`),
        t(`${fx(O.AGE.ma.value, 3)} Ma`, 'when', `± ${O.AGE.ma.sigma * 1000} thousand years`),
    ].join('');
}

// ── step 1: posterior map ───────────────────────────────────────────────────
let postHover = null;
function drawPosterior() {
    const p = posterior(S.scenario, S.craterKm);
    const cv = $('chx-post'), g = cv.getContext('2d'), W = cv.width, H = cv.height;
    const m = { l: 62, r: 16, t: 14, b: 46 }, pw = W - m.l - m.r, ph = H - m.t - m.b;
    const Ls = p.map.diameters, vs = p.map.speeds;
    const x = (L) => m.l + pw * Math.log(L / Ls[0]) / Math.log(Ls[Ls.length - 1] / Ls[0]);
    const y = (v) => m.t + ph * (1 - Math.log(v / vs[0]) / Math.log(vs[vs.length - 1] / vs[0]));
    g.fillStyle = SURFACE; g.fillRect(0, 0, W, H);
    const cw = pw / (Ls.length - 1), ch = ph / (vs.length - 1);
    for (let i = 0; i < Ls.length; i++) for (let j = 0; j < vs.length; j++) {
        const d = p.map.density[i * vs.length + j];
        if (d < 0.02) continue;
        g.fillStyle = `rgba(57,135,229,${Math.min(1, 0.12 + 0.88 * Math.sqrt(d))})`;
        g.fillRect(x(Ls[i]) - cw / 2, y(vs[j]) - ch / 2, cw + 0.6, ch + 0.6);
    }
    g.save(); g.beginPath(); g.rect(m.l, m.t, pw, ph); g.clip();
    // the speed each size needs (the crater's curve)
    g.strokeStyle = INK; g.lineWidth = 2; g.beginPath();
    let started = false;
    for (let i = 0; i < Ls.length; i++) {
        const v = R.speedForCrater(Ls[i], { craterKm: S.craterKm, angleDeg: 55, density: 2200 });
        if (v == null) continue;
        if (started) g.lineTo(x(Ls[i]), y(v)); else { g.moveTo(x(Ls[i]), y(v)); started = true; }
    }
    g.stroke();
    // the size the iridium layer weighs
    const irL = M.diameterFromMass(M.massFromIridium({ fluenceNgCm2: O.IRIDIUM.fluenceNgCm2.value, abundanceNgG: O.IRIDIUM.abundanceNgG.CM }), 2200) / 1000;
    g.strokeStyle = ORANGE; g.lineWidth = 2; g.setLineDash([6, 4]); g.beginPath(); g.moveTo(x(irL), m.t); g.lineTo(x(irL), m.t + ph); g.stroke(); g.setLineDash([]);
    g.restore();
    // axes
    g.font = '12px Segoe UI, system-ui, sans-serif'; g.fillStyle = MUTED; g.strokeStyle = GRID; g.lineWidth = 1;
    g.textAlign = 'center';
    for (const L of [3, 5, 7, 10, 14, 20, 30]) { g.beginPath(); g.moveTo(x(L), m.t); g.lineTo(x(L), m.t + ph); g.stroke(); g.fillText(String(L), x(L), H - 26); }
    g.fillText('impactor diameter, km', m.l + pw / 2, H - 8);
    g.textAlign = 'right';
    for (const v of [12, 15, 20, 30, 42, 60, 72]) { g.beginPath(); g.moveTo(m.l, y(v)); g.lineTo(m.l + pw, y(v)); g.stroke(); g.fillText(String(v), m.l - 8, y(v) + 4); }
    g.save(); g.translate(14, m.t + ph / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.fillText('speed at the ground, km/s', 0, 0); g.restore();
    // limits, labelled on the chart
    g.fillStyle = INK2; g.textAlign = 'left';
    g.fillText('fastest a Sun-bound body can arrive (72 km/s)', m.l + 8, y(72) + 15);
    g.fillText('iridium layer', Math.min(x(irL) + 6, m.l + pw - 80), m.t + ph - 8);
    // published simulations
    const pts = [];
    for (const q of O.PUBLISHED_IMPACTORS) {
        const px = x(q.diameterKm), py = y(q.speedKms);
        g.beginPath(); g.arc(px, py, 6.5, 0, 7); g.fillStyle = SURFACE; g.fill();
        g.beginPath(); g.arc(px, py, 4.5, 0, 7); g.fillStyle = INK; g.fill();
        pts.push({ px, py, q });
    }
    cv._geo = { m, pw, ph, Ls, vs, pts, x, y, p };
    if (postHover) { g.strokeStyle = 'rgba(255,255,255,.35)'; g.beginPath(); g.moveTo(postHover.x, m.t); g.lineTo(postHover.x, m.t + ph); g.moveTo(m.l, postHover.y); g.lineTo(m.l + pw, postHover.y); g.stroke(); }

    const irNote = S.scenario === 'all-iridium'
        ? `With every gram of iridium counted, the body is ${range(p.diameterKm, 1)} km across and has to arrive at ${fx(p.speedKms.lo, 0)} km/s or more — the search runs into the 72 km/s ceiling. That is a comet's speed, and the ruthenium isotopes say it was not a comet.`
        : S.scenario === 'crater-only'
            ? `The crater alone allows anything from a ${fx(p.diameterKm.hi, 0)} km body at ${fx(p.speedKms.lo, 0)} km/s to a ${fx(p.diameterKm.lo, 0)} km body at ${fx(p.speedKms.hi, 0)} km/s.`
            : `At the speeds main-belt asteroids arrive, the body is ${range(p.diameterKm)} km across, and the global layer holds only ${range(p.fDep, 0, 100)} % of its iridium.`;
    $('chx-post-kv').innerHTML = [
        ['Diameter', `${fx(p.diameterKm.med, 1)} km (${range(p.diameterKm, 1)})`],
        ['Speed', `${fx(p.speedKms.med, 1)} km/s (${range(p.speedKms, 1)})`],
        ['Mass', `${sci(p.massKg.med)} kg`],
        ['Energy', `${sci(p.energyJ.med)} J (${sci(p.energyJ.lo)} – ${sci(p.energyJ.hi)})`],
        ['Iridium in the global layer', S.scenario === 'all-iridium' ? 'all of it (imposed)' : `${range(p.fDep, 0, 100)} % of the impactor's`],
    ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    $('chx-post-note').textContent = `${irNote} Ranges are 68 %. The white curve is drawn for a 55° arrival and a density of 2200 kg/m³; the shading covers 1400–2700 kg/m³ and all angles.`;
}
$('chx-post').addEventListener('pointermove', (e) => {
    const cv = e.currentTarget, geo = cv._geo; if (!geo) return;
    const r = cv.getBoundingClientRect(), k = cv.width / r.width;
    const px = (e.clientX - r.left) * k, py = (e.clientY - r.top) * k;
    const hit = geo.pts.find((p) => Math.hypot(p.px - px, p.py - py) < 14);
    const inside = px >= geo.m.l && px <= geo.m.l + geo.pw && py >= geo.m.t && py <= geo.m.t + geo.ph;
    if (hit) {
        const q = hit.q, w = M.forward({ diameterKm: q.diameterKm, speedKms: q.speedKms, angleDeg: q.angleDeg, density: q.density });
        showTip(`${q.label}\n${q.diameterKm} km at ${q.speedKms} km/s, ${q.angleDeg}°\nthrough these scaling laws: ${fx(w.finalKm, 0)} km crater\n${q.verified ? 'inputs checked' : 'inputs from memory'}`, e.clientX, e.clientY);
        postHover = null;
    } else if (inside) {
        const L = geo.Ls[0] * (geo.Ls[geo.Ls.length - 1] / geo.Ls[0]) ** ((px - geo.m.l) / geo.pw);
        const v = geo.vs[0] * (geo.vs[geo.vs.length - 1] / geo.vs[0]) ** (1 - (py - geo.m.t) / geo.ph);
        const w = M.forward({ diameterKm: L, speedKms: v, angleDeg: 55, density: 2200 });
        showTip(`${fx(L, 1)} km at ${fx(v, 1)} km/s\ncrater ${fx(w.finalKm, 0)} km · energy ${sci(w.energyJ)} J\ncarries ${fx(w.iridiumNgCm2 / O.IRIDIUM.fluenceNgCm2.value, 1)}× the layer's iridium`, e.clientX, e.clientY);
        postHover = { x: px, y: py };
    } else { tip.hidden = true; postHover = null; }
    drawPosterior();
});
$('chx-post').addEventListener('pointerleave', () => { postHover = null; tip.hidden = true; drawPosterior(); });

// ── step 2: trajectory ──────────────────────────────────────────────────────
const T = { v: 18, th: 55, az: 45, sun: 30, hr: 10 };
const SEASON = (lon) => (lon < 8 ? 'March equinox' : lon > 82 ? 'June solstice' : `${Math.round(lon / 30.4 * 30.4)} days into spring`);
function bearingName(az) { return ['north', 'north-north-east', 'north-east', 'east-north-east', 'east'][Math.round(az / 22.5)] ?? `${az}°`; }

function drawOrbit() {
    const b = R.backtrack({ speedKms: T.v, angleDeg: T.th, fromAzimuthDeg: T.az, latDeg: LAT, localHour: T.hr, sunLonDeg: T.sun });
    const o = b.orbit, W = 520, H = 300, cx = 200, cy = 150, s = 26;       // px per au
    const earthAng = (T.sun + 180) * Math.PI / 180;
    const ring = (a, label, dash) => `<circle cx="${cx}" cy="${cy}" r="${a * s}" fill="none" stroke="${GRID}" stroke-width="1" ${dash ? 'stroke-dasharray="3 4"' : ''}/><text x="${cx + a * s * 0.707 + 4}" y="${cy - a * s * 0.707}" fill="${MUTED}" font-size="10">${label}</text>`;
    let path = '';
    const col = CLASS[b.cls].color === NONE ? MUTED : CLASS[b.cls].color;
    if (o) {
        const p = o.bound ? o.aAu * (1 - o.e * o.e) : o.qAu * (1 + o.e);
        const peri = earthAng - o.nuDeg * Math.PI / 180;                  // direction of perihelion
        const lim = o.e >= 1 ? Math.acos(-1 / o.e) - 0.02 : Math.PI;
        const pts = [];
        for (let k = -240; k <= 240; k++) {
            const nu = lim * k / 240, r = p / (1 + o.e * Math.cos(nu));
            if (!(r > 0) || r > 9) { if (pts.length && pts[pts.length - 1] !== 'M') pts.push('M'); continue; }
            const X = cx + s * r * Math.cos(peri + nu), Y = cy - s * r * Math.sin(peri + nu);
            pts.push(`${pts.length === 0 || pts[pts.length - 1] === 'M' ? 'M' : 'L'}${X.toFixed(1)} ${Y.toFixed(1)}`);
        }
        path = `<path d="${pts.filter((q) => q !== 'M').join(' ')}" fill="none" stroke="${col}" stroke-width="2" ${o.bound ? '' : 'stroke-dasharray="5 4"'}/>`;
    }
    const ex = cx + s * Math.cos(earthAng), ey = cy - s * Math.sin(earthAng);
    $('chx-orbit').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="The reconstructed orbit seen from above the Solar System">
      <rect x="${cx - 3.3 * s}" y="0" width="0" height="0"/>
      <circle cx="${cx}" cy="${cy}" r="${3.3 * s}" fill="rgba(255,255,255,.035)"/><circle cx="${cx}" cy="${cy}" r="${2.1 * s}" fill="${SURFACE}"/>
      ${ring(1, 'Earth')}${ring(1.52, 'Mars')}${ring(5.2, 'Jupiter', true)}
      <text x="${cx}" y="${cy - 2.65 * s}" fill="${MUTED}" font-size="10" text-anchor="middle">asteroid belt</text>
      ${path}
      <circle cx="${cx}" cy="${cy}" r="5" fill="#ffd27a"/><text x="${cx + 8}" y="${cy + 4}" fill="${INK2}" font-size="10">Sun</text>
      <circle cx="${ex}" cy="${ey}" r="6" fill="${SURFACE}"/><circle cx="${ex}" cy="${ey}" r="4" fill="${INK}"/>
      <text x="${ex + 8}" y="${ey + 14}" fill="${INK2}" font-size="10">impact</text>
      <text x="362" y="24" fill="${INK}" font-size="13" font-weight="700">${esc(CLASS[b.cls].label)}</text>
      <text x="362" y="44" fill="${INK2}" font-size="11">${o?.bound ? `reaches ${fx(o.qAu, 2)}–${fx(o.QAu, 2)} au` : 'faster than the Sun can hold'}</text>
      <text x="362" y="60" fill="${INK2}" font-size="11">${o ? `tilted ${fx(o.incDeg, 0)}° to Earth's orbit` : ''}</text>
      <text x="362" y="${H - 10}" fill="${MUTED}" font-size="10">drawn in the orbit's own plane</text>
    </svg>`;
    const g = b.geocentric;
    $('chx-orbit-kv').innerHTML = [
        ['Speed far from Earth', `${fx(g.vInfKms, 1)} km/s (Earth's pull added ${fx(T.v - g.vInfKms, 1)} km/s and bent the path ${fx(g.bendDeg, 1)}°)`],
        ['It came out of the sky', `${fx(b.elongationDeg, 0)}° from the Sun, ${fx(Math.abs(b.radiant.eclLatDeg), 0)}° ${b.radiant.eclLatDeg >= 0 ? 'north' : 'south'} of the planets' plane`],
        ['Orbit', o?.bound ? `a ${fx(o.aAu, 2)} au · e ${fx(o.e, 2)} · i ${fx(o.incDeg, 1)}° · Tisserand ${fx(o.tisserand, 2)}` : `not bound to the Sun (${fx(o.vHelioKms, 1)} km/s at 1 au; the limit is 42.1)`],
    ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

function drawHours() {
    const fam = R.orbitFamily({ latDeg: LAT, speedKms: T.v, angleDeg: T.th, fromAzimuthDeg: T.az, sunLonDeg: T.sun, hours: 48 });
    const W = 520, H = 92, l = 8, r = 8, w = (W - l - r) / 48;
    let cells = '';
    fam.rows.forEach((row, i) => {
        const c = CLASS[row.cls], o = row.orbit;
        const sel = Math.abs(row.localHour - T.hr) < 0.01;
        const txt = `${clock(row.localHour)} local time\n${c.label}${o?.bound ? `\nreaches ${fx(o.qAu, 2)}–${fx(o.QAu, 2)} au, tilted ${fx(o.incDeg, 0)}°` : ''}`;
        cells += `<rect x="${l + i * w + 1}" y="22" width="${w - 2}" height="${sel ? 40 : 34}" rx="2" fill="${c.color}" data-tip="${esc(txt)}" data-hr="${row.localHour}" style="cursor:pointer"/>`;
        if (sel) cells += `<rect x="${l + i * w - 0.5}" y="19.5" width="${w + 1}" height="45" rx="3" fill="none" stroke="${INK}" stroke-width="1.5"/>`;
    });
    const ticks = [0, 6, 12, 18, 24].map((h) => `<text x="${l + h * 2 * w}" y="80" fill="${MUTED}" font-size="10" text-anchor="${h === 0 ? 'start' : h === 24 ? 'end' : 'middle'}">${['midnight', 'dawn', 'noon', 'dusk', 'midnight'][h / 6]}</text>`).join('');
    $('chx-hours').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Kind of orbit for each local time of impact">
      <text x="${l}" y="13" fill="${INK2}" font-size="11">The orbit it must have been on, for each time of day it could have hit</text>${cells}${ticks}</svg>`;
    const used = [...new Set(fam.rows.map((x) => CLASS[x.cls].label))];
    $('chx-class-legend').innerHTML = Object.values(CLASS).filter((c, i, a) => a.findIndex((d) => d.label === c.label) === i && used.includes(c.label))
        .map((c) => `<span><i style="background:${c.color}"></i>${c.label}</span>`).join('');
    const a = fam.share.asteroidal;
    $('chx-traj-note').textContent = a === 1
        ? `At ${fx(T.v, 1)} km/s every hour of the day gives an ordinary asteroid orbit: the trajectory says nothing about the time of impact. Raise the speed and hours start to drop out.`
        : `At ${fx(T.v, 1)} km/s, ${Math.round(a * 100)} % of the day gives an asteroid-like orbit. Across the reconstruction's whole range of speeds, angles and bearings, a main-belt-like orbit is possible in ${Math.round(HOURS.overall * 100)} % of cases — most often for an impact around ${clock(HOURS.bestHour)} local time. Before dawn the site faced the way Earth was travelling, and a body met head-on there was on a small orbit that stays inside Mars's: still an asteroid's orbit, but not one that reaches the belt. Click a bar to pick that hour.`;
}
let HOURS = null;
function renderTrajectory() {
    $('chx-v-o').textContent = `${fx(T.v, 1)} km/s`; $('chx-th-o').textContent = `${T.th}°`;
    $('chx-az-o').textContent = `from ${bearingName(T.az)}`; $('chx-sun-o').textContent = SEASON(T.sun); $('chx-hr-o').textContent = clock(T.hr);
    drawOrbit(); drawHours();
}
for (const [id, key] of [['chx-v', 'v'], ['chx-th', 'th'], ['chx-az', 'az'], ['chx-sun', 'sun'], ['chx-hr', 'hr']]) {
    $(id).addEventListener('input', (e) => { T[key] = Number(e.target.value); renderTrajectory(); });
}
$('chx-hours').addEventListener('click', (e) => {
    const h = e.target.dataset?.hr; if (h == null) return;
    T.hr = Number(h); $('chx-hr').value = h; renderTrajectory();
});

// ── step 3: effects with distance ───────────────────────────────────────────
const R_MIN = 150, R_MAX = 20000;
const sliderKm = (f) => R_MIN * (R_MAX / R_MIN) ** f;
const SITES = O.EJECTA_SITES.map((s) => ({ ...s, rKm: M.greatCircle(LAT, LON, s.latDeg, s.lonDeg) / 1000 }));
function renderEffects() {
    const rKm = sliderKm(Number($('chx-r').value)), x = M.effectsAt(FWD, rKm);
    $('chx-r-o').textContent = `${rKm < 1000 ? Math.round(rKm / 10) * 10 : Math.round(rKm / 100) * 100} km`;
    const nearSite = SITES.find((s) => Math.abs(Math.log(s.rKm / rKm)) < 0.06);
    $('chx-r-place').textContent = nearSite ? `about as far as ${nearSite.name} is today` : rKm > 19000 ? 'the far side of the planet' : '';
    const items = [];
    if (x.thermalJm2 > 0) items.push([0, 'seconds', `<b>The fireball is above the horizon.</b> About ${sci(x.thermalJm2)} J/m² of heat arrives — ${x.thermalJm2 > 1e6 ? 'enough to set fire to anything that burns' : 'a strong flash'}.`]);
    else items.push([0, '—', `The ${fx(FWD.fireballKm, 0)} km fireball is below the horizon. Nothing is seen yet.`]);
    items.push([x.seismic.arrivalS, dur(x.seismic.arrivalS), `<b>The ground shakes.</b> A magnitude ${fx(x.seismic.magnitude, 1)} earthquake — the first waves arrive now and the shaking lasts many minutes.`]);
    if (x.ejecta.arrivalS != null) {
        const th = x.ejecta.thicknessM;
        const how = th == null ? '' : th >= 1 ? `a blanket about ${fx(th, 0)} m thick` : th >= 0.01 ? `a layer about ${fx(th * 100, 0)} cm thick` : `a layer of a few millimetres`;
        items.push([x.ejecta.arrivalS, dur(x.ejecta.arrivalS), `<b>Debris falls from the sky.</b> Rock thrown out at ${fx(x.ejecta.launchKms, 1)} km/s has flown ${x.ejecta.apogeeKm > 100 ? `${fx(x.ejecta.apogeeKm, 0)} km up, above the atmosphere, and re-enters glowing` : 'here on a low arc'}; it builds ${how}.`]);
    }
    items.push([x.tsunami.arrivalS, dur(x.tsunami.arrivalS), `<b>On an open coast, the sea arrives.</b> A wave of roughly ${x.tsunami.heightM >= 1000 ? `${fx(x.tsunami.heightM / 1000, 1)} km` : `${fx(x.tsunami.heightM, 0)} m`} in deep water${rKm > 3000 ? ' — real coasts and seafloor change this a great deal' : ''}.`]);
    items.push([x.blast.arrivalS, dur(x.blast.arrivalS), `<b>The air blast.</b> Winds near ${fx(x.blast.windMs, 0)} m/s (${fx(x.blast.windMs * 3.6, 0)} km/h)${rKm > 3000 ? ' — an order-of-magnitude figure this far out' : ''}.`]);
    items.sort((a, b) => a[0] - b[0]);
    $('chx-timeline').innerHTML = x.insideCrater
        ? '<li><b>0 s</b><span>This is inside the crater. The ground here is excavated or melted in the first seconds.</span></li>'
        : items.map(([, when, text]) => `<li><b>${when}</b><span>${text}</span></li>`).join('');
    drawEjecta(rKm);
}
function drawEjecta(rSel) {
    const W = 900, H = 250, m = { l: 60, r: 130, t: 14, b: 40 }, pw = W - m.l - m.r, ph = H - m.t - m.b;
    const x = (r) => m.l + pw * Math.log(r / R_MIN) / Math.log(R_MAX / R_MIN);
    const y = (t) => m.t + ph * (1 - (Math.log10(t) + 3.3) / 5.3);            // 0.5 mm … 100 m
    let d = '';
    for (let i = 0; i <= 120; i++) {
        const r = R_MIN * (R_MAX / R_MIN) ** (i / 120), t = M.ejectaThickness(FWD.transientKm * 1000, r * 1000);
        if (t == null || t < 10 ** -3.3) continue;
        d += `${d ? 'L' : 'M'}${x(r).toFixed(1)} ${y(t).toFixed(1)}`;
    }
    const grid = [[100, '100 m'], [1, '1 m'], [0.01, '1 cm'], [0.001, '1 mm']].map(([t, lab]) => `<line x1="${m.l}" x2="${m.l + pw}" y1="${y(t)}" y2="${y(t)}" stroke="${GRID}"/><text x="${m.l - 8}" y="${y(t) + 4}" fill="${MUTED}" font-size="11" text-anchor="end">${lab}</text>`).join('');
    const xt = [200, 500, 1000, 2000, 5000, 10000, 20000].map((r) => `<text x="${x(r)}" y="${H - 20}" fill="${MUTED}" font-size="11" text-anchor="middle">${r.toLocaleString('en-US')}</text>`).join('');
    const dots = SITES.filter((s) => s.thicknessM != null).map((s) => {
        const pred = M.ejectaThickness(FWD.transientKm * 1000, s.rKm * 1000);
        const txt = `${s.name}\nmeasured ${fx(s.thicknessM * 100, 1)} cm · this law ${fx(pred * 100, 1)} cm\n${Math.round(s.rKm)} km away today\n${s.verified ? 'thickness checked' : 'thickness from memory'}`;
        const whisk = s.hiM ? `<line x1="${x(s.rKm)}" x2="${x(s.rKm)}" y1="${y(s.hiM)}" y2="${y(Math.max(s.loM || s.thicknessM, 0.002))}" stroke="${INK2}" stroke-width="1.5"/>` : '';
        return `${whisk}<circle cx="${x(s.rKm)}" cy="${y(s.thicknessM)}" r="6.5" fill="${SURFACE}"/><circle cx="${x(s.rKm)}" cy="${y(s.thicknessM)}" r="4.5" fill="${INK}"/>
          <circle cx="${x(s.rKm)}" cy="${y(s.thicknessM)}" r="14" fill="transparent" data-tip="${esc(txt)}"/>
          <text x="${x(s.rKm) + 9}" y="${y(s.thicknessM) - 8}" fill="${INK2}" font-size="11">${esc(s.name.split(',')[0])}</text>`;
    }).join('');
    const yd = y(O.DISTAL_LAYER.thicknessMm / 1000);
    $('chx-ejecta').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Thickness of the debris layer against distance from the crater">
      ${grid}${xt}<text x="${m.l + pw / 2}" y="${H - 4}" fill="${MUTED}" font-size="11" text-anchor="middle">distance from the crater, km</text>
      <line x1="${x(O.DISTAL_LAYER.beyondKm)}" x2="${m.l + pw}" y1="${yd}" y2="${yd}" stroke="${ORANGE}" stroke-width="2"/>
      <text x="${m.l + pw + 8}" y="${yd + 4}" fill="${INK2}" font-size="11">global layer, 3 mm</text>
      <path d="${d}" fill="none" stroke="${BLUE}" stroke-width="2"/>
      <text x="${m.l + pw + 8}" y="${m.t + 12}" fill="${INK2}" font-size="11">thrown-out rock</text><text x="${m.l + pw + 8}" y="${m.t + 26}" fill="${INK2}" font-size="11">(scaling law)</text>
      <line x1="${x(rSel)}" x2="${x(rSel)}" y1="${m.t}" y2="${m.t + ph}" stroke="rgba(255,255,255,.35)" stroke-dasharray="3 4"/>
      ${dots}</svg>`;
    $('chx-ejecta-note').textContent = 'Blue: debris thrown out along the ground-hugging blanket, thinning as the cube of distance. Orange: the fine layer that condensed from the vapour plume and settled everywhere, which the blanket law does not describe. White points are measured sections, plotted at today\'s distance from the crater — Haiti was closer 66 million years ago, which is part of why it sits above the curve.';
}

// ── step 4: climate ─────────────────────────────────────────────────────────
function renderClimate() {
    const soot = O.CLIMATE_TARGETS.find((c) => c.id === 'soot');
    const tau0 = M.opticalDepth(soot.massTg, soot.agent), life = M.lifetimeFromDarkness(tau0, soot.darkYears);
    const dep = M.impliedOceanDepth({ tau0, lifetimeYr: life, targetCoolingK: soot.peakCoolingK });
    const shallow = M.impactWinter({ tau0, lifetimeYr: life, years: 30 });
    const deep = M.impactWinter({ tau0, lifetimeYr: life, heatCapacity: dep.heatCapacity, years: 30 });
    const W = 900, hp = 150, gap = 34, m = { l: 60, r: 150, t: 18 }, pw = W - m.l - m.r, H = m.t + hp * 2 + gap + 34;
    const x = (t) => m.l + pw * t / 30;
    const yL = (f) => m.t + hp * (1 - f), top2 = m.t + hp + gap, tMin = -70;
    const yT = (k) => top2 + hp * (k / tMin);
    const line = (run, key, yy) => { let d = ''; for (let i = 0; i < run.t.length; i += 4) d += `${d ? 'L' : 'M'}${x(run.t[i]).toFixed(1)} ${yy(run[key][i]).toFixed(1)}`; return d; };
    const xt = [0, 2, 5, 10, 15, 20, 25, 30].map((t) => `<line x1="${x(t)}" x2="${x(t)}" y1="${m.t}" y2="${top2 + hp}" stroke="${GRID}"/><text x="${x(t)}" y="${H - 16}" fill="${MUTED}" font-size="11" text-anchor="middle">${t}</text>`).join('');
    const tl = [0, -20, -40, -60].map((k) => `<line x1="${m.l}" x2="${m.l + pw}" y1="${yT(k)}" y2="${yT(k)}" stroke="${GRID}"/><text x="${m.l - 8}" y="${yT(k) + 4}" fill="${MUTED}" font-size="11" text-anchor="end">${k === 0 ? '0' : `−${-k}`} °C</text>`).join('');
    const ll = [0, 0.5, 1].map((f) => `<line x1="${m.l}" x2="${m.l + pw}" y1="${yL(f)}" y2="${yL(f)}" stroke="${GRID}"/><text x="${m.l - 8}" y="${yL(f) + 4}" fill="${MUTED}" font-size="11" text-anchor="end">${f * 100} %</text>`).join('');
    const hover = Array.from({ length: 60 }, (_, i) => {
        const t = i / 2 + 0.25, k = Math.round(t / 30 * (shallow.t.length - 1));
        return `<rect x="${x(i / 2)}" y="${m.t}" width="${pw / 60}" height="${top2 + hp - m.t}" fill="transparent" data-tip="${esc(`Year ${fx(t, 1)}\nsunlight at the ground: ${shallow.light[k] < 0.001 ? 'less than 0.1' : fx(shallow.light[k] * 100, shallow.light[k] < 0.1 ? 1 : 0)} %\nshallow ocean layer: ${fx(shallow.T[k], 0)} °C\n${fx(dep.oceanDepthM, 0)} m of ocean: ${fx(deep.T[k], 1)} °C`)}"/>`;
    }).join('');
    $('chx-climate').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Sunlight and global temperature in the years after the impact">
      ${xt}${ll}${tl}
      <text x="${m.l}" y="${m.t - 5}" fill="${INK2}" font-size="11">Sunlight reaching the ground</text>
      <text x="${m.l}" y="${top2 - 5}" fill="${INK2}" font-size="11">Global temperature change</text>
      <rect x="${x(0)}" y="${m.t}" width="${x(soot.darkYears) - x(0)}" height="${hp}" fill="rgba(255,255,255,.05)"/>
      <text x="${x(5.3)}" y="${yL(0.07)}" fill="${INK2}" font-size="11">← too dark for photosynthesis (${soot.darkYears} yr, published)</text>
      <path d="${line(shallow, 'light', yL)}" fill="none" stroke="${INK}" stroke-width="2"/>
      <path d="${line(shallow, 'T', yT)}" fill="none" stroke="${ORANGE}" stroke-width="2"/>
      <path d="${line(deep, 'T', yT)}" fill="none" stroke="${BLUE}" stroke-width="2"/>
      <line x1="${m.l}" x2="${m.l + pw}" y1="${yT(-soot.peakCoolingK)}" y2="${yT(-soot.peakCoolingK)}" stroke="${INK2}" stroke-dasharray="5 4"/>
      <text x="${m.l + pw + 8}" y="${yT(-soot.peakCoolingK) + 4}" fill="${INK2}" font-size="11">climate model: −${soot.peakCoolingK} °C</text>
      <text x="${x(shallow.peakAtYr) + 10}" y="${yT(-shallow.peakCoolingK) + 4}" fill="${INK2}" font-size="11">with 60 m of ocean</text>
      <text x="${x(22)}" y="${yT(deep.T[Math.round(22 / 30 * (deep.T.length - 1))]) - 8}" fill="${INK2}" font-size="11">with ${fx(dep.oceanDepthM, 0)} m of ocean</text>
      <text x="${m.l + pw / 2}" y="${H - 2}" fill="${MUTED}" font-size="11" text-anchor="middle">years after the impact</text>
      ${hover}</svg>`;
    $('chx-climate-legend').innerHTML = `<span><i class="line" style="background:${INK}"></i>sunlight</span><span><i class="line" style="background:${ORANGE}"></i>temperature, 60 m ocean layer</span><span><i class="line" style="background:${BLUE}"></i>temperature, ${fx(dep.oceanDepthM, 0)} m ocean layer</span>`;
    const co2 = M.co2Forcing(O.VOLATILES.co2Gt.value), re = M.reentryHeating();
    $('chx-climate-note').textContent = `${soot.massTg.toLocaleString('en-US')} million tonnes of soot spread evenly is an optical depth of ${fx(tau0, 0)}: no direct sunlight at all. The darkness lasts the ${soot.darkYears} years the published climate model found (that is an input here). A box with a 60 m ocean layer then cools by ${fx(shallow.peakCoolingK, 0)} °C — four times the model's ${soot.peakCoolingK} °C. Matching the model takes the heat of about ${fx(dep.oceanDepthM, 0)} m of ocean: the cold surface water sinks and the deep ocean keeps the planet from freezing. Not shown: the first hours, when re-entering debris heated the upper air by up to ${fx(re.fluxWm2 / 1000, 0)} kW/m² (an upper bound); the ${O.VOLATILES.sulfurGt.value} billion tonnes of sulfur, which add to the cooling; and the ${O.VOLATILES.co2Gt.value} billion tonnes of CO₂, worth about +${fx(co2.forcingWm2 / 1.2, 1)} °C once the sky cleared.`;
}

// ── evidence ────────────────────────────────────────────────────────────────
const GROUPS = { crater: 'The crater', age: 'When', target: 'What it hit', iridium: 'The iridium layer', density: 'The body', type: 'What kind of body', trajectory: 'Trajectory', published: 'Published impactors', energy: 'Energy', ejecta: 'Debris', tsunami: 'The sea', volatiles: 'Into the air', climate: 'Climate-model results', extinction: 'Life' };
const LABEL = { centre: 'Crater centre', rimDiameterKm: 'Outer rim', innerRimDiameterKm: 'Inner (topographic) rim', peakRingDiameterKm: 'Peak ring', transientCavityDiameterKm: 'Transient cavity', mohoUpliftKm: 'Mantle uplift', burialDepthKm: 'Buried under', ma: 'Age', season: 'Season', sedimentThicknessKm: 'Sediment cover', lithology: 'Rock', crustDensity: 'Crust density', waterDepthKm: 'Water depth', fluenceNgCm2: 'Global iridium', fluenceLowNgCm2: 'Global iridium (lower estimate)', nearCraterNgCm2: 'Iridium near the crater', abundanceNgG: 'Iridium in chondrites', density: 'Bulk density', angleDeg: 'Angle to the ground', fromAzimuthDeg: 'Came from', evidence: 'Asymmetry', joules: 'Impact energy', seismicMw: 'Earthquake magnitude', distal: 'Global layer', earlyWave: 'First wave', ringWave: 'Ring wave', gulfOpenOceanM: 'Gulf of Mexico', farCoastsM: 'Distant coasts', energyVs2004: 'Tsunami energy vs 2004', sulfurGt: 'Sulfur', co2Gt: 'Carbon dioxide', sootTg: 'Soot', fineDustTg: 'Fine dust', extinction: 'Species lost' };
const UNIT = { rimDiameterKm: 'km', innerRimDiameterKm: 'km', peakRingDiameterKm: 'km', transientCavityDiameterKm: 'km', mohoUpliftKm: 'km', burialDepthKm: 'km', sedimentThicknessKm: 'km', waterDepthKm: 'km', crustDensity: 'kg/m³', fluenceNgCm2: 'ng/cm²', fluenceLowNgCm2: 'ng/cm²', nearCraterNgCm2: 'ng/cm²', density: 'kg/m³', angleDeg: '°', fromAzimuthDeg: '° bearing', joules: 'J', sulfurGt: 'Gt', co2Gt: 'Gt', sootTg: 'Tg', gulfOpenOceanM: 'm', farCoastsM: 'm', energyVs2004: '×' };
function valueOf(r, key) {
    const u = UNIT[key] ? ` ${UNIT[key]}` : '', big = (n) => (Math.abs(n) >= 1e5 ? sci(n) : String(n));
    if (r.latDeg != null && r.thicknessM === undefined) return `${fx(r.latDeg, 2)}°N ${fx(-r.lonDeg, 2)}°W`;
    if (r.thicknessM !== undefined) return r.thicknessM == null ? '—' : `${fx(r.thicknessM * 100, 1)} cm`;
    if (r.thicknessMm != null) return `${r.thicknessMm} mm`;
    if (r.diameterKm != null) return `${r.diameterKm} km · ${r.speedKms} km/s · ${r.angleDeg}°`;
    if (r.heightKm != null) return `${r.heightKm} km at ${r.atMin} min`;
    if (r.peakCoolingK != null) return `−${r.peakCoolingK} °C`;
    if (r.speciesLostPct != null) return `~${r.speciesLostPct} %`;
    if (r.CM != null) return `CM ${r.CM} · CI ${r.CI} ng/g`;
    if (r.result) return r.result;
    if (typeof r.value === 'number') return `${big(r.value)}${r.sigma ? ` ± ${r.sigma}` : r.lo != null ? ` (${big(r.lo)}–${big(r.hi)})` : ''}${u}`;
    if (typeof r.value === 'string') return r.value;
    if (r.lo != null && r.hi != null) return `${big(r.lo)}–${big(r.hi)}${u}`;
    if (r.lo != null) return `> ${big(r.lo)}${u}`;
    return '—';
}
function renderEvidence() {
    const rows = O.allRows(); let html = '', last = null;
    for (const r of rows) {
        if (r.group !== last) { html += `<tr class="grp"><td colspan="5">${GROUPS[r.group] ?? r.group}</td></tr>`; last = r.group; }
        const kind = r.kind === 'inferred' || r.group === 'published' || r.group === 'climate' ? '<span class="chx-badge model">model result</span>' : 'measured';
        html += `<tr><td>${esc(LABEL[r.key] ?? r.key)}${r.note ? `<div class="chx-fine" style="margin-top:2px">${esc(r.note)}</div>` : ''}</td><td class="num">${esc(valueOf(r, r.key))}</td><td>${kind}</td><td>${esc(r.source)}</td><td>${r.verified ? '<span class="chx-badge ok">✓ checked</span>' : '<span class="chx-badge no">from memory</span>'}</td></tr>`;
    }
    $('chx-evidence').querySelector('tbody').innerHTML = html;
    $('chx-open').innerHTML = `<li style="list-style:none;margin-left:0;color:#f3f5ff;font-weight:700;margin-top:12px">Still missing</li>` + O.OPEN_DATA.map((t) => `<li>${esc(t)}</li>`).join('');
}

// ── boot ────────────────────────────────────────────────────────────────────
segmented('chx-scenario', (v) => { S.scenario = v; drawPosterior(); });
segmented('chx-rim', (v) => { S.craterKm = Number(v); drawPosterior(); });
$('chx-r').addEventListener('input', renderEffects);
renderTiles(); drawPosterior(); renderEvidence(); renderEffects(); renderClimate();
T.v = Math.round(base.speedKms.med * 2) / 2; $('chx-v').value = T.v;
{
    const speeds = [14, 17, 20, 24, 28, 34];
    HOURS = R.hourConstraint({ latDeg: LAT, speeds, speedWeights: speeds.map(R.asteroidSpeedDensity), hours: 48 });
    T.hr = HOURS.bestHour; $('chx-hr').value = T.hr;
}
renderTrajectory();
window.__chicxulub = { O, M, R, base, FWD, state: { S, T }, HOURS };
