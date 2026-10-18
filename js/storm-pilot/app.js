/**
 * storm-pilot/app.js — the page: screens (map → hangar → flight → debrief),
 * the HUD, keyboard + touch input, the fixed-step loop, and saving.
 *
 * The sim steps at a fixed 120 Hz no matter the frame rate; the renderer draws
 * once per animation frame. `window.__stormPilot` is the browser gate's hook.
 */
import * as SIM from './sim.js';
import { PLANETS, PLANET_ORDER, timeScale } from './planets.js';
import { SHIPS, SHIP_ORDER } from './ships.js';
import { DEBRIS, SHARD_REPRESENTS } from './debris.js';
import { LEVELS, levelById, levelUnlocked, planetUnlocked, endlessUnlocked, shipUnlocked, totalStars } from './levels.js';
import { Renderer } from './render.js';
import { drawShip, SHIP_ART } from './art.js';
import { ProgressStore } from './save.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtT = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const STEP = 1 / 120;

const store = new ProgressStore();
const renderer = new Renderer($('sp-canvas'));
let telemetry = null;
import('../telemetry.js').then((m) => { telemetry = m.telemetry; }).catch(() => {});
const track = (action, meta = {}) => { try { telemetry?.recordFeature('storm-pilot', action, meta); } catch { /* fire-and-forget */ } };

const state = {
    mode: 'title',                 // title | hangar | flight | pause | debrief
    planet: 'earth', level: 1, ship: 'kestrel', endless: false,
    G: null, keys: {}, acc: 0, last: performance.now(), seed: null,
};

/* ── screens ───────────────────────────────────────────────────────────── */

const SCREENS = ['sp-title', 'sp-hangar', 'sp-pause', 'sp-debrief'];
function show(mode) {
    state.mode = mode;
    const id = { title: 'sp-title', hangar: 'sp-hangar', pause: 'sp-pause', debrief: 'sp-debrief' }[mode] || null;
    for (const s of SCREENS) $(s).hidden = s !== id;
    $('sp-hud').hidden = !(mode === 'flight' || mode === 'pause');
    document.body.classList.toggle('sp-flying', mode === 'flight' || mode === 'pause');
}

function renderTitle() {
    const p = store.get();
    const map = $('sp-map'); map.innerHTML = '';
    PLANET_ORDER.forEach((id, i) => {
        const P = PLANETS[id], open = planetUnlocked(p, id);
        if (i) map.insertAdjacentHTML('beforeend', '<span class="sp-link" aria-hidden="true"></span>');
        const lv = LEVELS.filter((l) => l.planet === id);
        const stars = lv.reduce((a, l) => a + (p.stars[l.id] || 0), 0), max = lv.length * 3;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'sp-node' + (open ? '' : ' lock') + (id === state.planet ? ' sel' : '');
        b.dataset.planet = id;
        b.style.setProperty('--c', P.look.map); b.style.setProperty('--s', P.look.size + 'px');
        b.innerHTML = `<span class="orb"></span><span class="nm">${P.name}</span><span class="st">${open ? `★ ${stars}/${max}` : '🔒'}</span>`;
        b.setAttribute('aria-label', `${P.name}${open ? `, ${stars} of ${max} stars` : ', locked'}`);
        const fact = () => { $('sp-fact').innerHTML = P.fact; };
        b.addEventListener('mouseenter', fact); b.addEventListener('focus', fact);
        b.addEventListener('click', () => {
            state.planet = id;
            const first = lv.find((l) => levelUnlocked(p, l.id));
            if (first) state.level = first.id;
            renderTitle();
        });
        map.appendChild(b);
    });
    $('sp-fact').innerHTML = PLANETS[state.planet].fact;

    const list = $('sp-levels'); list.innerHTML = '';
    for (const l of LEVELS.filter((x) => x.planet === state.planet)) {
        const open = levelUnlocked(p, l.id), s = p.stars[l.id] || 0;
        const b = document.createElement('button');
        b.type = 'button'; b.dataset.level = l.id;
        b.className = 'sp-lv' + (open ? '' : ' lock') + (l.id === state.level ? ' on' : '');
        b.innerHTML = `<b>${l.id} · ${esc(l.name)}</b><span>${open ? esc(l.brief) : 'Clear the level before it to unlock'}</span><i>${open ? '★'.repeat(s) + '☆'.repeat(3 - s) : '🔒'}</i>`;
        b.disabled = !open;
        b.addEventListener('click', () => { state.level = l.id; renderTitle(); });
        list.appendChild(b);
    }
    const eOpen = endlessUnlocked(p, state.planet), best = p.best[state.planet];
    $('sp-b-endless').disabled = !eOpen;
    $('sp-b-endless').textContent = eOpen ? `∞ Endless ${PLANETS[state.planet].name}${best ? ` · best ${fmtT(best)}` : ''}` : `∞ Endless · clear a ${PLANETS[state.planet].name} level`;
    $('sp-b-play').disabled = !levelUnlocked(p, state.level) || levelById(state.level)?.planet !== state.planet;
    renderAccount();
}

function renderAccount() {
    const el = $('sp-account');
    if (store.signedIn) {
        el.innerHTML = `Signed in as <b>${esc(store.user.email || 'pilot')}</b>. Your stars are saved. <span class="sp-total">★ ${totalStars(store.get())}</span>`;
    } else {
        el.innerHTML = 'Playing as a guest: stars last until you close this tab. <button type="button" class="sp-linkbtn" id="sp-b-save">Save my progress, free</button>';
        $('sp-b-save').addEventListener('click', openSaveGate);
    }
}

async function openSaveGate() {
    track('save_gate');
    try { const { openGate } = await import('../gate-modal.js'); openGate('save-satellite'); }
    catch { location.href = 'signin.html?next=' + encodeURIComponent(location.pathname); }
}

function renderHangar() {
    const p = store.get(), el = $('sp-ships'); el.innerHTML = '';
    hangarArt.length = 0;
    if (!shipUnlocked(p, state.ship)) state.ship = 'kestrel';
    for (const id of SHIP_ORDER) {
        const s = SHIPS[id], open = shipUnlocked(p, id);
        const b = document.createElement('button');
        b.type = 'button'; b.dataset.ship = id;
        b.className = 'sp-ship' + (open ? '' : ' lock') + (id === state.ship ? ' on' : '');
        b.setAttribute('aria-pressed', String(id === state.ship));
        b.innerHTML = `<canvas aria-hidden="true"></canvas><div><div class="nm">${open ? '' : '🔒 '}${s.name}</div><div class="cls">${s.cls}</div></div>` +
            Object.entries(s.bars).map(([k, v]) => `<div class="bar">${k}<i style="--v:${v}%"></i></div>`).join('') +
            `<div class="special"><b>✦ ${s.special.name}</b> · ${esc(s.special.desc)}${open ? '' : ` Unlocks at ${s.unlockStars} ★.`}</div>`;
        b.addEventListener('click', () => { if (!open) return; state.ship = id; renderHangar(); });
        el.appendChild(b);
        hangarArt.push({ c: b.querySelector('canvas'), id, b });
    }
    const l = levelById(state.level);
    $('sp-hangar-sub').textContent = state.endless ? `Endless · ${PLANETS[state.planet].name}` : `Level ${l.id} · ${l.name} · ${PLANETS[l.planet].name}`;
}
const hangarArt = [];
function drawHangar(t) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const h of hangarArt) {
        const w = h.c.clientWidth || 200, hh = h.c.clientHeight || 120;
        if (h.c.width !== Math.round(w * dpr)) { h.c.width = Math.round(w * dpr); h.c.height = Math.round(hh * dpr); }
        const g = h.c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, hh); g.translate(w / 2, hh / 2);
        const sc = Math.min((w / 2 - 10) / SHIP_ART[h.id].R, (hh / 2 - 8) / 22);
        const hot = h.id === state.ship || h.b.matches(':hover');
        drawShip(g, h.id, { ang: -Math.PI / 2 + Math.sin(t * 0.6) * 0.12, scale: sc, t, thrust: hot });
    }
}

/* ── flight ────────────────────────────────────────────────────────────── */

function startFlight() {
    const seed = state.seed ?? ((Date.now() ^ (Math.random() * 1e9)) >>> 0);
    state.G = state.endless
        ? SIM.createGame({ planetId: state.planet, shipId: state.ship, endless: true, seed })
        : SIM.createGame({ levelId: state.level, shipId: state.ship, seed });
    state.keys = {}; state.acc = 0;
    renderer.parts = []; renderer.viewR = state.G.view;
    const G = state.G, P = G.planet;
    $('sp-sp-name').textContent = G.ship.special.name;
    $('sp-k-special').hidden = !!G.ship.special.passive;
    setSasChips('free');
    const clouds = G.clouds.map((k) => `${DEBRIS[k].name} (${DEBRIS[k].year})`).join(', ');
    banner(state.endless ? `ENDLESS · ${P.name.toUpperCase()}` : `LEVEL ${G.level.id} · ${G.level.name.toUpperCase()}`,
        state.endless ? 'Storms keep coming, each stronger than the last. Collect orbs and survive.' : G.level.brief, 3.2);
    tip(state.endless ? `Storms build every half minute.${clouds ? ` Debris in orbit: <b>${esc(clouds)}</b>.` : ''}` : G.level.tip, 10);
    $('sp-scale-note').innerHTML = scaleNote(P);
    show('flight');
    track('launch', { level: state.endless ? `endless-${state.planet}` : state.level, ship: state.ship });
}

function scaleNote(P) {
    return `<b>Game scale.</b> Altitude is compressed (about linear through low orbit, about logarithmic beyond) and time runs about ×${Math.round(timeScale(P))} at ${P.name} so an orbit takes ~40 s. Drag is sped up even more, so a storm's months of orbit decay play out in seconds. Real: Newtonian orbits, each planet's own kind of magnetic field, and a magnetopause that shrinks with solar-wind pressure to the −1/6 power (Chapman–Ferraro), the same law space-weather forecasters use. Debris clouds sit at their real breakup altitudes; each shard stands for about ${SHARD_REPRESENTS} tracked fragments, and cross-plane debris is drawn as fragments orbiting the other way.`;
}

function input() {
    const k = state.keys;
    return { left: k.left, right: k.right, thrust: k.thrust, boost: k.boost };
}

function finishRun() {
    const G = state.G, res = SIM.result(G);
    store.record(res, state.endless ? null : G.level.id, state.planet);
    track('finish', { level: state.endless ? `endless-${state.planet}` : G.level.id, win: res.win, stars: res.stars, t: Math.round(res.t) });
    $('sp-d-title').textContent = state.endless ? `Survived ${fmtT(res.t)}` : res.win ? 'Mission complete' : 'Signal lost';
    $('sp-d-stars').textContent = state.endless ? `◆ ${res.data}` : '★'.repeat(res.stars) + '☆'.repeat(3 - res.stars);
    $('sp-d-stars').setAttribute('aria-label', state.endless ? `${res.data} data orbs` : `${res.stars} of 3 stars`);
    const rows = [
        ['Outcome', res.win ? 'Success' : res.why || 'Ended'], ['Data orbs', res.data], ['Flight time', fmtT(res.t)],
        ['Hull left', `${Math.round(res.hullFrac * 100)}%`], ['Fuel left', `${Math.round(res.fuelFrac * 100)}%`],
        ['Lowest altitude', `${Math.round(res.minAltKm).toLocaleString()} km`], ['Radiation dose', `${res.dose.toFixed(1)} krad`],
    ];
    if (G.clouds.length) rows.push(['Debris strikes', res.hits], ['Close calls dodged', res.nearMiss], ['Fragments dragged down', res.decayed]);
    if (res.wingsLost) rows.push(['Wings lost', res.wingsLost]);
    $('sp-d-stats').innerHTML = rows.map(([a, b]) => `<span>${a}</span><span>${esc(b)}</span>`).join('');
    // One story for the level, plus one for a debris cloud you flew through: a card, not a wall.
    const cloud = res.clouds.length ? res.clouds[Math.floor(G.rng() * res.clouds.length)] : null;
    const real = [state.endless ? PLANETS[state.planet].fact : G.level.real, cloud?.real].filter(Boolean);
    $('sp-d-real').innerHTML = real.map((r) => `<p>${r}</p>`).join('');
    const next = !state.endless && res.win ? levelById(G.level.id + 1) : null;
    $('sp-b-next').hidden = !next;
    if (next) $('sp-b-next').textContent = `Next: ${next.name} ▸`;
    $('sp-d-save').hidden = store.signedIn || !(res.stars > 0 || state.endless);
    show('debrief');
}

/* ── HUD ───────────────────────────────────────────────────────────────── */

const hudCache = {};
function setText(id, v) { if (hudCache[id] !== v) { hudCache[id] = v; $(id).textContent = v; } }
function setHtml(id, v) { if (hudCache[id] !== v) { hudCache[id] = v; $(id).innerHTML = v; } }
function cells(id, frac) {
    const el = $(id), c = el.querySelector('.cells'), n = 8, on = Math.ceil(Math.max(0, Math.min(1, frac)) * n);
    if (c.childElementCount !== n) c.innerHTML = '<u></u>'.repeat(n);
    [...c.children].forEach((u, i) => u.classList.toggle('off', i >= on));
    el.classList.toggle('low', frac < 0.25);
    el.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
}
function hud() {
    const G = state.G, S = G.S, T = SIM.telemetry(G);
    cells('sp-m-hull', G.hull / G.ship.hull); cells('sp-m-pwr', G.pwr / 100); cells('sp-m-fuel', G.fuel / 100);
    setText('sp-h-sun', `${Math.round(G.sunEff * 100)}%`);
    setText('sp-h-data', state.endless ? `◆ ${G.data}` : `◆ ${G.data}/${G.goal}`);
    setText('sp-h-time', fmtT(G.t));
    const field = T.standoff == null ? (G.planet.field.type === 'crustal' ? `CRUSTAL FIELDS ${T.cover ? '<b class="ok">OVERHEAD</b>' : 'none overhead'}` : '')
        : `${G.planet.field.type === 'induced' ? 'INDUCED BOUNDARY' : 'MAGNETOPAUSE'} <b>${T.crushed ? 'ON THE SURFACE' : `${T.standoff.toFixed(1)} R`}</b>`;
    const status = T.inside || T.cover ? '<b class="ok">SHIELDED</b>' : '<b class="bad">EXPOSED</b>';
    setHtml('sp-tele', `ALT <b>${Math.round(T.altKm).toLocaleString()}</b> km · <b>${T.kms.toFixed(2)}</b> km/s<br>${field ? field + '<br>' : ''}` +
        `${G.clouds.length ? `TRACKED DEBRIS <b>${T.frags}</b> shards<br>` : ''}DOSE <b>${T.dose.toFixed(2)}</b>/s · ${status}${T.shadow ? ' · ECLIPSE' : ''}`);
    $('sp-sp-cd').style.setProperty('--cd', `${G.ship.special.cd ? (G.spCd / G.ship.special.cd) * 100 : 0}%`);
    $('sp-k-shield').classList.toggle('on', G.shield);
    $('sp-k-thrust').classList.toggle('on', G.thrusting);
    // one alert at a time, most urgent first
    let msg = '';
    if (G._flashMsg && G.t < G._flashMsg.until) msg = `${G._flashMsg.a}<small>${G._flashMsg.b}</small>`;
    else if (G.conj) msg = `CONJUNCTION ${G.conj.tca.toFixed(1)}s<small>${esc(G.conj.f.cloud === 'own' ? 'Your own lost wing' : DEBRIS[G.conj.f.cloud].name + ' fragment')} · closing ${G.conj.relKms.toFixed(1)} km/s · burn!</small>`;
    else if (S.flare > 0.1) msg = `${S.flareCls || 'X'} FLARE!<small>Radio blackout · protons incoming</small>`;
    else if (S.eta != null) msg = `CME INBOUND ${Math.ceil(S.eta)}s<small>${G.planet.field.type === 'dipole' ? 'Get inside the magnetopause' : 'Find cover: the shadow or a shielded zone'}</small>`;
    else if (T.crushed && !G.ex.shadow) msg = 'MAGNETOPAUSE CRUSHED<small>The day side is wide open. Get to the night side</small>';
    else if (S.P > 3 && T.standoff != null) msg = `STORM · P ×${Math.round(S.P)}<small>Boundary at ${T.standoff.toFixed(1)} planet radii</small>`;
    else if (S.dust) msg = 'GLOBAL DUST STORM<small>The upper air is heating up and dragging you down</small>';
    else if (G.ex.heat > 0.3) msg = 'DAYSIDE HEAT!<small>Climb, or get to the night side</small>';
    else if (G.rate > 1.6) msg = 'RADIATION!<small>Shield up, or find cover</small>';
    else if (G.ship.ion && G.sunEff < 0.05 && state.keys.thrust) msg = 'ION DRIVE DARK<small>No sunlight on the arrays</small>';
    setHtml('sp-alert', msg);
    $('sp-alert').classList.toggle('on', !!msg);
}

function handleFx(G) {
    for (const e of G.fx) {
        if (e.type === 'toast') G._flashMsg = { a: e.text.toUpperCase(), b: '', until: G.t + 1.6 };
        else if (e.type === 'strike' && !e.big) G._flashMsg = { a: `DEBRIS STRIKE −${Math.round(e.dmg)}`, b: `${e.cloud === 'own' ? 'Your own wing' : DEBRIS[e.cloud].name + ' fragment'} at ${e.relKms.toFixed(1)} km/s`, until: G.t + 1.6 };
        else if (e.type === 'wing') G._flashMsg = { a: 'WING SHEARED OFF', b: 'Half your array power is gone, and the wing is now debris', until: G.t + 2.4 };
        else if (e.type === 'tip') tip(e.text, 6);
    }
}

let bannerT = 0, tipTimer = 0;
function banner(a, b, secs) { $('sp-banner').innerHTML = `${esc(a)}<small>${esc(b)}</small>`; $('sp-banner').classList.add('on'); bannerT = secs; }
function tip(html, secs) { $('sp-tip').innerHTML = html; $('sp-tip').classList.add('on'); clearTimeout(tipTimer); tipTimer = setTimeout(() => $('sp-tip').classList.remove('on'), secs * 1000); }
function setSasChips(mode) {
    document.querySelectorAll('#sp-sas .chip').forEach((c) => { const on = c.dataset.sas === mode; c.classList.toggle('on', on); c.setAttribute('aria-pressed', String(on)); });
}

/* ── input ─────────────────────────────────────────────────────────────── */

const KEYMAP = { KeyW: 'thrust', ArrowUp: 'thrust', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', ShiftLeft: 'boost', ShiftRight: 'boost' };
const SAS_KEYS = { Digit1: 'free', Digit2: 'pro', Digit3: 'retro', Digit4: 'out', Digit5: 'in' };
function toggleShield() { const G = state.G; if (G && !G.done) SIM.setShield(G, !G.shield); }
function special() { const G = state.G; if (G && !G.done) SIM.useSpecial(G); }
function sas(mode) { const G = state.G; if (!G) return; SIM.setSas(G, mode); setSasChips(G.sas); }

window.addEventListener('keydown', (e) => {
    if (state.mode !== 'flight' && state.mode !== 'pause') return;
    if (e.target?.closest?.('input,textarea,select,[contenteditable]')) return;
    if (e.code === 'Escape' || e.code === 'KeyP') { togglePause(); e.preventDefault(); return; }
    if (state.mode !== 'flight') return;
    if (KEYMAP[e.code]) { state.keys[KEYMAP[e.code]] = true; e.preventDefault(); }
    if (e.code === 'Space') { if (!e.repeat) toggleShield(); e.preventDefault(); }
    if (e.code === 'KeyX' && !e.repeat) special();
    if (SAS_KEYS[e.code]) sas(SAS_KEYS[e.code]);
});
window.addEventListener('keyup', (e) => { if (KEYMAP[e.code]) state.keys[KEYMAP[e.code]] = false; });
window.addEventListener('blur', () => { state.keys = {}; if (state.mode === 'flight') togglePause(); });

document.querySelectorAll('.sp-key').forEach((b) => {
    const k = b.dataset.k;
    const down = (e) => {
        e.preventDefault();
        if (k === 'shield') toggleShield(); else if (k === 'special') special(); else state.keys[k] = true;
        try { b.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    };
    const up = () => { if (k !== 'shield' && k !== 'special') state.keys[k] = false; };
    b.addEventListener('pointerdown', down);
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, up);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
});
document.querySelectorAll('#sp-sas .chip').forEach((c) => c.addEventListener('click', () => sas(c.dataset.sas)));

function togglePause() {
    if (state.mode === 'flight') { show('pause'); state.keys = {}; }
    else if (state.mode === 'pause') { show('flight'); state.last = performance.now(); }
}

$('sp-b-play').addEventListener('click', () => { state.endless = false; renderHangar(); show('hangar'); });
$('sp-b-endless').addEventListener('click', () => { state.endless = true; renderHangar(); show('hangar'); });
$('sp-b-back').addEventListener('click', () => { renderTitle(); show('title'); });
$('sp-b-launch').addEventListener('click', startFlight);
$('sp-b-pause').addEventListener('click', togglePause);
$('sp-b-resume').addEventListener('click', togglePause);
$('sp-b-quit').addEventListener('click', () => { state.G = null; renderTitle(); show('title'); });
$('sp-b-again').addEventListener('click', startFlight);
$('sp-b-next').addEventListener('click', () => { state.level += 1; state.planet = levelById(state.level).planet; renderHangar(); show('hangar'); });
$('sp-b-map').addEventListener('click', () => { renderTitle(); show('title'); });
$('sp-d-save').addEventListener('click', openSaveGate);
window.addEventListener('resize', () => renderer.resize());
store.onChange(() => { if (state.mode === 'title') renderTitle(); else renderAccount(); });

/* ── loop ──────────────────────────────────────────────────────────────── */

function frame(now) {
    const dt = Math.min(0.1, (now - state.last) / 1000); state.last = now;
    const t = now / 1000, G = state.G;
    if (state.mode === 'flight' && G) {
        state.acc += dt;
        while (state.acc >= STEP && !G.done) { SIM.stepGame(G, input(), STEP); state.acc -= STEP; }
        handleFx(G); renderer.consume(G); G.fx.length = 0;
        if (G.sas !== hudCache.sas) { hudCache.sas = G.sas; setSasChips(G.sas); }
        hud();
        if (bannerT > 0 && (bannerT -= dt) <= 0) $('sp-banner').classList.remove('on');
        if (G.done) {                                   // let the last frames play, then debrief
            state.mode = 'ending';
            setTimeout(() => { if (state.G === G && state.mode === 'ending') finishRun(); }, 900);
        }
    }
    if (G && (state.mode === 'flight' || state.mode === 'pause' || state.mode === 'ending' || state.mode === 'debrief')) renderer.draw(G, t, state.mode === 'pause' ? 0 : dt);
    else renderer.drawIdle(PLANETS[state.planet], t, dt);
    if (state.mode === 'hangar') drawHangar(t);
    requestAnimationFrame(frame);
}

/* ── boot ──────────────────────────────────────────────────────────────── */

const q = new URLSearchParams(location.search);
if (q.has('seed')) state.seed = Number(q.get('seed')) >>> 0;
renderTitle();
show('title');
requestAnimationFrame((t) => { state.last = t; frame(t); });
store.init().then(() => {
    renderTitle();
    import('../gate-modal.js').then(({ consumeResume }) => {
        const msg = consumeResume('save-satellite');
        if (msg && state.mode === 'title') $('sp-account').insertAdjacentHTML('afterbegin', `<b class="ok">${esc(msg)}</b> `);
    }).catch(() => {});
});

// Browser-gate hook: drive runs deterministically without the keyboard.
window.__stormPilot = {
    sim: SIM, store, state,
    get game() { return state.G; },
    start({ level = 1, ship = 'kestrel', planet = null, endless = false, seed = 1 } = {}) {
        state.seed = seed; state.ship = ship; state.endless = endless;
        if (endless) state.planet = planet; else { state.level = level; state.planet = levelById(level).planet; }
        startFlight();
        return state.G;
    },
    finish() { if (state.G && !state.G.done) { state.G.done = true; state.G.win = true; finishRun(); } },
};
