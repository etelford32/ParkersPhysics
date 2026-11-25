/**
 * deep-time-earth.js — wires deep-time-earth.html. Computes nothing: positions
 * come from js/paleo/rotations.js, plates from js/paleo/plates.js, every
 * sentence from js/deep-time/page-model.js, and js/deep-time/globe.js draws.
 *
 * URL: ?age=<Ma>&at=<lat>,<lon> (present-day point to select) — the
 * Chicxulub page links here with the crater at 66.04 Ma; ?second=0 starts
 * without the second model.
 *
 * THE SECOND MODEL (Merdith et al. 2021, palaeomagnetic frame) is fetched
 * AFTER the globe is drawn so it never delays the first frame; until it
 * arrives every comparison row says it is loading, and if it fails the page
 * says so and keeps working on the first model alone.
 */
import * as PR from './paleo/rotations.js';
import * as PL from './paleo/plates.js';
import * as M from './deep-time/page-model.js';
import { MAJOR_CITIES } from './data/major-cities.js';
import { loadUserLocation } from './user-location.js';

const $ = (id) => document.getElementById(id);
const CITY_NAMES = ['London', 'New York', 'Rio de Janeiro', 'Cape Town', 'Mumbai', 'Sydney', 'Tokyo', 'Nairobi', 'Reykjavík', 'Honolulu', 'Moscow'];
const PLAY_MA_PER_S = 10;

const ageInput = $('dte-age'), playBtn = $('dte-play');
const S = { age: 0, pick: null, track: null, track2: null, playing: false, globe: null, second: null, spread: null, secondState: 'off' };
const COLORS = { first: '#ffd166', second: '#ff6fd8' };

function fmtKm(km) { return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km).toLocaleString('en-US')} km`; }

// ── the slider's furniture: left = 250 Ma, right = today ──────────────────────
const xOf = (age) => `${(100 * (M.AGE_MAX - age) / M.AGE_MAX).toFixed(3)}%`;
function buildClock() {
    $('dte-periods').innerHTML = M.PERIODS.map((p) => {
        const from = Math.min(p.from, M.AGE_MAX);
        const w = 100 * (from - p.to) / M.AGE_MAX;
        return `<div style="left:${xOf(from)};width:${w.toFixed(3)}%;background:${p.color}" title="${p.name} (${p.from}–${p.to} Ma)">${w > 9 ? p.name : ''}</div>`;
    }).join('');
    $('dte-stops').innerHTML = M.STOPS.map((s) => `<button type="button" data-age="${s.age}" title="${s.title}" style="left:${xOf(s.age)}">${s.label}</button>`).join('');
    $('dte-stops').addEventListener('click', (e) => { const b = e.target.closest('button[data-age]'); if (b) { stop(); setAge(Number(b.dataset.age)); } });
    ageInput.addEventListener('input', () => { stop(); setAge(Number(ageInput.value)); });
}

function setAge(age) {
    S.age = Math.max(0, Math.min(M.AGE_MAX, age));
    ageInput.value = String(S.age);
    const p = M.periodAt(S.age);
    $('dte-when').querySelector('b').textContent = M.formatAge(S.age);
    $('dte-when').querySelector('span').textContent = p && S.age > 0.005 ? `${p.name} period` : '';
    $('dte-age-out').textContent = `${S.age.toFixed(S.age < 10 ? 2 : 1)} Ma`;
    if (S.globe) S.globe.setAge(S.age);
    renderSpread();
    renderPoint();
}

// ── the second model: how far apart the two put the continents at this age ───
function renderSpread() {
    const el = $('dte-spread');
    if (S.secondState === 'loading') { el.textContent = 'Loading the second model (Merdith et al. 2021)…'; return; }
    if (S.secondState === 'failed') { el.textContent = 'The second model could not be loaded, so this page shows one model only.'; return; }
    if (S.secondState !== 'on' || !S.spread) { el.textContent = ''; return; }
    const r = M.spreadAt(S.spread, primary(), S.second, S.age);
    el.innerHTML = S.age < 0.005 || r.medianDLat == null
        ? 'Two models, Müller 2019 and Merdith 2021, agree on today by definition. Move the slider to see where they part.'
        : `Two models disagree: they put today's continents a median <b>${r.medianDLat.toFixed(1)}°</b> apart in latitude at this age (90 % within ${r.p90DLat.toFixed(1)}°). That is the least the uncertainty can be. The pink outlines are turned ${Math.abs(r.lonShiftDeg ?? 0).toFixed(0)}° ${(r.lonShiftDeg ?? 0) >= 0 ? 'west' : 'east'} about the pole onto the first model's longitudes, which palaeomagnetism cannot fix; no latitude is changed.`;
}
const primary = () => ({ model: S.model, plates: S.plates });

// ── play: forward in time, toward today ──────────────────────────────────────
let raf = 0, last = 0;
function stop() { S.playing = false; cancelAnimationFrame(raf); playBtn.textContent = 'Play'; playBtn.setAttribute('aria-pressed', 'false'); }
function play() {
    if (S.age <= 0.001) setAge(M.AGE_MAX);
    S.playing = true; playBtn.textContent = 'Pause'; playBtn.setAttribute('aria-pressed', 'true');
    last = 0;
    const step = (t) => {
        if (!S.playing) return;
        const dt = last ? Math.min(0.25, (t - last) / 1000) : 0;
        last = t;
        const next = S.age - PLAY_MA_PER_S * dt;
        setAge(next <= 0 ? 0 : next);
        if (S.age <= 0) { stop(); return; }
        raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
}
playBtn.addEventListener('click', () => (S.playing ? stop() : play()));

// ── the point panel ──────────────────────────────────────────────────────────
function selectPresent(lat, lon, label) {
    S.pick = { lat, lon, label, hit: PL.plateAt(S.plates, lat, lon) };
    S.track = M.trackSamples(S.model, S.plates, lat, lon, 1);
    S.track2 = S.secondState === 'on' ? M.trackSamples(S.second.model, S.second.plates, lat, lon, 1) : null;
    if (S.globe) {
        S.globe.setTrack(S.track);
        // drawn on the globe in the FIRST model's longitudes (the same alignment as the pink coastlines); the chart plots latitude only
        S.globe.setTrack2(S.track2 && { ...S.track2, points: S.track2.points.map((p) => ({ ...p, lon: p.lon - M.shiftAt(S.shifts, p.age) })) });
    }
    renderPoint();
}

function renderPoint() {
    const body = $('dte-point-body'), chart = $('dte-chart');
    if (!S.pick || !S.model) return;
    const r = M.pointReport(S.model, S.plates, S.pick.lat, S.pick.lon, S.age);
    const name = S.pick.label ? `<b>${S.pick.label}</b>` : 'The point you picked';
    if (r.reason === 'no-plate') {
        body.innerHTML = `<p class="dte-hint">${name} (${M.formatLatLon(r.today)}) is in a gap between the model's plate outlines, so it has no plate to follow.</p>`;
        chart.innerHTML = '';
        return;
    }
    const rows = [
        ['Plate', `${r.plateName || 'unnamed'} (${r.plate})`],
        ['Today', `${M.formatLatLon(r.today)} · ${r.bandToday || M.latitudeBand(r.today.lat)}`],
        ['Crust', r.continental ? 'continental' : r.fromAge >= M.CRUST_AGE_UNKNOWN ? 'ocean floor of unknown age' : `ocean floor, formed ${Math.round(r.fromAge)} million years ago`],
    ];
    if (r.ok) {
        rows.push([S.age > 0.005 ? `At ${S.age.toFixed(S.age < 10 ? 2 : 1)} Ma` : 'At the slider', S.age > 0.005 ? `${M.formatLatLon(r.then)} · ${r.band}` : 'where it is today']);
        if (S.age > 0.005) rows.push(['Moved since', `${fmtKm(r.movedKm)} in a straight line, relative to the mantle`]);
    } else {
        rows.push([`At ${S.age.toFixed(1)} Ma`, r.reason === 'not-formed' ? `not there yet: this crust formed ${Math.round(r.fromAge)} million years ago` : 'beyond what the model covers for this plate']);
    }
    if (S.secondState === 'on') {
        const cmp = M.compareModels(primary(), S.second, S.pick.lat, S.pick.lon, S.age, M.shiftAt(S.shifts, S.age));
        if (S.age < 0.005) rows.push(['Second model', 'agrees today (both start from the present)']);
        else if (cmp.dLatDeg != null) {
            rows.push([`<span style="color:${COLORS.second}">Second model</span>`, `${M.formatLat(cmp.b.then.lat)} · ${cmp.b.band}`]);
            rows.push(['Difference', `${Math.abs(cmp.dLatDeg).toFixed(1)}° of latitude (${cmp.dLatDeg >= 0 ? 'further north' : 'further south'} in the second)${cmp.apartKmAligned != null ? `; ${fmtKm(cmp.apartKmAligned)} apart once their longitudes are aligned (${fmtKm(cmp.apartKm)} as each frame writes longitude)` : ''}`]);
        } else rows.push(['Second model', cmp.b.ok ? '—' : cmp.b.reason === 'not-formed' ? 'its crust had not formed yet in that model' : cmp.b.reason === 'no-plate' ? 'no plate there in that model' : 'beyond what that model covers here']);
    } else if (S.secondState === 'loading') rows.push(['Second model', 'loading…']);
    if (S.track) rows.push(['Followed back', `${Math.round(S.track.maxAge)} million years (${r.reach.limit === 'crust' ? 'when this crust formed' : r.reach.limit === 'plate' ? 'the plate’s oldest row in the model' : 'the model’s end'}) · path ${fmtKm(S.track.pathKm)}`]);
    body.innerHTML = `<p class="dte-hint">${name}, carried back on its plate.</p><dl class="dte-kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
    const W = 340, H = 170, c = M.latitudeChart(S.track, W, H, { second: S.track2 });
    if (!c) { chart.innerHTML = ''; return; }
    const now = S.track.points.reduce((b, p) => (Math.abs(p.age - S.age) < Math.abs(b.age - S.age) ? p : b));
    const showNow = S.age <= S.track.maxAge + 1e-9;
    chart.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Latitude of the point against age">
      ${c.yTicks.map((t) => `<line x1="${c.pad.l}" x2="${W - c.pad.r}" y1="${t.y}" y2="${t.y}" stroke="rgba(255,255,255,${t.v === 0 ? 0.25 : 0.08})"/><text x="${c.pad.l - 4}" y="${t.y + 3}" fill="#8a93ad" font-size="9" text-anchor="end">${t.label}</text>`).join('')}
      ${c.xTicks.map((t) => `<text x="${t.x}" y="${H - 6}" fill="#8a93ad" font-size="9" text-anchor="middle">${t.label}</text>`).join('')}
      <text x="${W - c.pad.r}" y="${H - 6 - 10}" fill="#8a93ad" font-size="8" text-anchor="end">million years ago →</text>
      ${c.path2 ? `<path d="${c.path2}" fill="none" stroke="${COLORS.second}" stroke-width="1.6" stroke-dasharray="4 3"/>` : ''}
      <path d="${c.path}" fill="none" stroke="${COLORS.first}" stroke-width="1.8"/>
      ${showNow ? `<circle cx="${c.x(now.age)}" cy="${c.y(now.lat)}" r="3.5" fill="${COLORS.first}" stroke="#03050c"/>` : ''}
    </svg><p class="dte-fine"><span style="color:${COLORS.first}">━</span> Müller et al. 2019, mantle frame${c.path2 ? ` · <span style="color:${COLORS.second}">┅</span> Merdith et al. 2021, spin-axis (palaeomagnetic) frame. The two share most of their data for this period, so the gap between the lines is the least the uncertainty can be, not its size.` : '. A mantle frame leaves out a few degrees of polar wander.'}</p>`;
}

// ── labels drawn over the canvas ─────────────────────────────────────────────
const marks = [];
function addMark(cls, lat, lon, label, opts = {}) {
    const el = document.createElement('div');
    el.className = `dte-mark ${cls}`;
    if (label) el.innerHTML = `<span></span>`, el.firstChild.textContent = label;
    $('dte-labels').appendChild(el);
    const hit = PL.plateAt(S.plates, lat, lon);
    const m = { el, lat, lon, hit, cls, minAge: opts.untilAge ?? null };
    marks.push(m);
    return m;
}
function placeMarks() {
    const g = S.globe, showCities = $('dte-cities').checked;
    for (const m of marks) {
        let p = null;
        if (m.hit && !(m.cls === 'city' && !showCities) && !(m.minAge != null && S.age > m.minAge + 1e-9)) p = projectPresent(m.lat, m.lon, m.hit);
        if (!p) { m.el.hidden = true; continue; }
        m.el.hidden = false;
        m.el.style.left = `${p.x}px`; m.el.style.top = `${p.y}px`;
    }
    pickMark.el.hidden = true;
    if (S.pick && S.pick.hit) {
        const p = projectPresent(S.pick.lat, S.pick.lon, S.pick.hit);
        if (p) { pickMark.el.hidden = false; pickMark.el.style.left = `${p.x}px`; pickMark.el.style.top = `${p.y}px`; }
    }
}
let pickMark = null;
/** Screen position of a present-day point at the slider's age, or null (not formed / beyond the model / far side). */
function projectPresent(lat, lon, hit) {
    if (S.age > M.reachOf(S.model, hit).maxAge + 1e-9) return null;
    const t = S.model.reconstruct(lat, lon, hit.plate, S.age);
    return t ? S.globe.project(PR.unitVector(t.lat, t.lon)) : null;
}

// ── boot ─────────────────────────────────────────────────────────────────────
async function boot() {
    buildClock();
    const get = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.json(); });
    let rot, plates, coast;
    try {
        [rot, plates, coast] = await Promise.all([get('data/paleo/muller2019-rotations.json'), get('data/paleo/muller2019-plates.json'), get('data/paleo/muller2019-coastlines.json')]);
    } catch (e) {
        $('dte-loading').textContent = `The plate model could not be loaded (${e.message}).`;
        return;
    }
    S.model = PR.createModel(rot);
    S.plates = PL.decodePlates(plates);
    const C = M.ORACLE_CHECK, n = (v) => v.toLocaleString('en-US'), m = (deg) => Math.max(1, Math.round(deg * 111195));
    $('dte-check').innerHTML = [['Müller et al. 2019', C.muller2019], ['Merdith et al. 2021', C.merdith2021]].map(([label, c]) =>
        `<b>${label}:</b> every plate's rotation at 16 ages from today to 250 million years ago. <b>${n(c.off)}</b> plate-and-age pairs agree with pyGPlates ${C.pygplates} to better than a millimetre. At <b>${n(c.at)}</b> more, the age is exactly where a plate switches from one reference plate to another; there the file allows two answers, both programs give one of them, and they differ by at most <b>${m(c.atDeg)} m</b>. Both refuse the same <b>${n(c.refusedBoth)}</b> pairs the model does not cover. <b>${n(c.agree)} of ${n(c.points)}</b> test points get the same plate as pyGPlates; the rest lie within a few kilometres of a boundary, where this page's simplified outlines differ slightly.`)
        .concat([`Where the Chicxulub crater and its debris sites were 66 million years ago (Müller 2019): agree to <b>${C.sitesDeg.toExponential(1)}°</b>.`])
        .map((t) => `<li>${t}</li>`).join('');

    let createGlobe;
    try { ({ createGlobe } = await import('./deep-time/globe.js')); } catch (e) { $('dte-loading').hidden = true; $('dte-fail').hidden = false; return; }
    const canvas = $('dte-globe');
    try {
        S.globe = createGlobe(canvas, {
            model: S.model, plates: S.plates, coast,
            onRender: () => placeMarks(),
            onPick: (hit) => {
                if (!hit) return;
                if (hit.plate == null) { S.pick = null; S.track = null; S.globe.setTrack(null); $('dte-point-body').innerHTML = `<p class="dte-hint">${S.age < 0.005 ? 'That spot is in a gap between the model\u2019s plate outlines.' : 'That spot is ocean floor that has since been destroyed. Nothing of it is left today to follow.'}</p>`; $('dte-chart').innerHTML = ''; return; }
                const p = M.presentPointOf(S.model, hit.plate, hit.unit, S.age);
                if (p) selectPresent(p.lat, p.lon, null);
            },
        });
    } catch (e) {
        $('dte-loading').hidden = true; $('dte-fail').hidden = false; canvas.hidden = true;
        console.warn('deep-time globe failed', e);
        return;
    }
    $('dte-loading').hidden = true;

    pickMark = { el: Object.assign(document.createElement('div'), { className: 'dte-mark pick' }) };
    $('dte-labels').appendChild(pickMark.el);
    for (const n of CITY_NAMES) { const c = MAJOR_CITIES.find((x) => x.n === n); if (c) addMark('city', c.lat, c.lon, c.n); }
    addMark('crater', M.CHICXULUB.lat, M.CHICXULUB.lon, 'Chicxulub crater', { untilAge: M.CHICXULUB.ageMa });
    const you = loadUserLocation();
    if (you && Number.isFinite(you.lat) && Number.isFinite(you.lon)) addMark('you', you.lat, you.lon, 'You');
    $('dte-cities').addEventListener('change', () => S.globe.render());
    $('dte-coast').addEventListener('change', () => S.globe.setCoastVisible($('dte-coast').checked));

    const presets = [['Chicxulub', M.CHICXULUB.lat, M.CHICXULUB.lon, M.CHICXULUB.ageMa], ...CITY_NAMES.slice(0, 7).map((n) => { const c = MAJOR_CITIES.find((x) => x.n === n); return c && [c.n, c.lat, c.lon, null]; }).filter(Boolean)];
    if (you && Number.isFinite(you.lat)) presets.unshift(['Where you are', you.lat, you.lon, null]);
    $('dte-presets').innerHTML = presets.map(([n], i) => `<button type="button" data-i="${i}">${n}</button>`).join('');
    $('dte-presets').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-i]'); if (!b) return;
        const [n, lat, lon, a] = presets[Number(b.dataset.i)];
        stop();
        if (a != null) setAge(a);
        selectPresent(lat, lon, n);
        const r = M.pointReport(S.model, S.plates, lat, lon, S.age);
        if (r.ok) S.globe.lookAt(r.then.lat, r.then.lon);
    });

    const q = new URLSearchParams(location.search);
    const qa = Number(q.get('age'));
    setAge(Number.isFinite(qa) && q.has('age') ? qa : 0);
    const at = (q.get('at') || '').split(',').map(Number);
    if (at.length === 2 && at.every(Number.isFinite)) {
        selectPresent(at[0], at[1], null);
        const r = M.pointReport(S.model, S.plates, at[0], at[1], S.age);
        if (r.ok) S.globe.lookAt(r.then.lat, r.then.lon);
    }
    window.__deepTime = { S, M, PR, PL, setAge, selectPresent, globe: S.globe, loadSecond };

    const toggle = $('dte-second');
    toggle.checked = q.get('second') !== '0';
    toggle.addEventListener('change', () => (toggle.checked ? loadSecond() : unloadSecond()));
    if (toggle.checked) requestAnimationFrame(() => setTimeout(loadSecond, 0));     // after the first frame
}

let secondData = null;
async function loadSecond() {
    if (S.secondState === 'on' || S.secondState === 'loading') return;
    S.secondState = 'loading'; renderSpread(); renderPoint();
    try {
        if (!secondData) {
            const get = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.json(); });
            const [rot, plates, coast] = await Promise.all([...M.SECOND_MODEL.files, M.SECOND_MODEL.coastFile].map(get));
            const second = { model: PR.createModel(rot), plates: PL.decodePlates(plates) };
            const spread = M.spreadSample(primary(), second, 1500);
            secondData = { second, coast, spread, shifts: M.lonShiftTable(spread, primary(), second, 2) };
        }
        if (!$('dte-second').checked) { S.secondState = 'off'; return; }
        S.second = secondData.second; S.spread = secondData.spread; S.shifts = secondData.shifts; S.secondState = 'on';
        S.globe.setSecondModel(S.second.model, secondData.coast, (a) => M.shiftAt(S.shifts, a));
    } catch (e) {
        console.warn('second model failed', e);
        S.secondState = 'failed';
    }
    if (S.pick) selectPresent(S.pick.lat, S.pick.lon, S.pick.label);
    renderSpread(); renderPoint();
}
function unloadSecond() {
    S.secondState = 'off'; S.second = null; S.spread = null; S.shifts = null; S.track2 = null;
    S.globe.setSecondModel(null, null); S.globe.setTrack2(null);
    renderSpread(); renderPoint();
}
boot();
