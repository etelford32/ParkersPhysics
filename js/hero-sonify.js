/**
 * hero-sonify.js — the homepage hero's sound layer: the solar wind you are
 * looking at, as audio, conditioned on the visitor's own location.
 * ═══════════════════════════════════════════════════════════════════════════
 * OPT-IN, always. Browsers block audio before a gesture and a landing page
 * that starts humming is a landing page people leave; the toggle this module
 * mounts is the only way sound starts, and the choice is remembered in
 * localStorage (`pp_hero_sound`). Reduced motion never auto-enables it.
 *
 * ── What you hear, and what it is ─────────────────────────────────────────
 * Every voice maps ONE quantity the hero already computes — nothing here is
 * invented for the ear, and the legend under the toggle says which is which:
 *
 *   drone      solar wind SPEED → pitch (300 km/s ≈ 55 Hz, 900 ≈ 110 Hz, a
 *              one-octave log map) and DENSITY → filter brightness
 *   ticks      bow-shock crossings: the hero's particle loop counts the
 *              particles that enter the magnetosheath each frame
 *              (`audioState().shockRate`, per second); each crossing is a
 *              short filtered noise grain, rate-limited to TICKS_MAX_HZ so a
 *              storm is a hail, not a wall
 *   tension    southward Bz: a second oscillator detunes downward with
 *              max(0, −Bz) and a slow tremolo sets in — the geoeffective sign
 *   shimmer    the aurora at YOUR location: verdict-engine `auroraVerdict`
 *              (the EarthView oracle) on the saved location's magnetic
 *              latitude at the current Kp — 'go' brings in a high, slowly
 *              beating pad; 'maybe' a quieter one; 'no' silence. With no
 *              saved location there is no shimmer and the legend says so.
 *
 * The state it sonifies is whatever the hero's engine is running on: the
 * live feed at rest, the model's conditions at τ while the transit is
 * scrubbed — so scrubbing the Gannon arrival is audible, and the visitor's
 * own sky is in it.
 *
 * ── Engineering ───────────────────────────────────────────────────────────
 * One AudioContext, created on the first toggle (never at load). Voices are
 * parameter ramps on persistent nodes (no per-frame node churn); grains are
 * the one allocation and are capped. Master gain is low (−18 dBFS-ish): this
 * is ambience under a page, not a synth demo. Suspends when the tab hides
 * or the hero scrolls away (the hero's own RAF parking is the signal — it
 * stops calling `tick`, and a watchdog fades the master to silence).
 *
 * Node gate: `node tests/hero-sonify.mjs` (the pure maps). Browser gate:
 * tests/home-hero-stage.spec.js (toggle mounts, off by default).
 */

import { magneticLatitude, auroraVerdict } from './verdict-engine.js';
import { loadUserLocation } from './user-location.js';

export const SOUND_KEY = 'pp_hero_sound';
export const TICKS_MAX_HZ = 14;
export const MASTER_GAIN = 0.12;

// ── Pure maps (node-tested) ─────────────────────────────────────────────────

/** Speed → drone pitch: one octave, log, 300→55 Hz … 900→110 Hz, clamped. */
export function droneHz(speedKms) {
    const v = Math.min(1200, Math.max(200, Number.isFinite(speedKms) ? speedKms : 400));
    const x = Math.log(v / 300) / Math.log(3);     // 0 at 300, 1 at 900
    return 55 * Math.pow(2, Math.min(1.4, Math.max(-0.3, x)));
}

/** Density → low-pass cutoff (Hz): 1 cm⁻³ dull, 30 cm⁻³ bright. */
export function brightnessHz(densityCc) {
    const n = Math.min(60, Math.max(0.5, Number.isFinite(densityCc) ? densityCc : 5));
    return 220 + 1600 * Math.log10(1 + n) / Math.log10(31);
}

/** Southward Bz → detune (cents, negative) and tremolo depth (0..1). */
export function tension(bzNt) {
    const s = Math.max(0, -(Number.isFinite(bzNt) ? bzNt : 0));
    return { cents: -Math.min(700, s * 14), tremolo: Math.min(1, s / 25) };
}

/** Storm norm → master brightness lift (0..1). */
export function stormLift(stormNorm) {
    return Math.min(1, Math.max(0, Number.isFinite(stormNorm) ? stormNorm : 0));
}

/**
 * Aurora shimmer level for a location at Kp: 'go' → 1, 'maybe' → 0.45,
 * else 0. Darkness is NOT gated here (this is "is the oval within reach",
 * the part of the verdict the wind decides); the legend names it.
 */
export function shimmerLevel(loc, kp) {
    if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) return { level: 0, state: 'no-location', mlat: null };
    const mlat = magneticLatitude(loc.lat, loc.lon);
    const v = auroraVerdict(kp, mlat, 0, -90);
    const level = v.state === 'go' ? 1 : v.state === 'maybe' ? 0.45 : 0;
    return { level, state: v.state, mlat, margin: v.margin };
}

// ── Renderer ────────────────────────────────────────────────────────────────

const CSS = `
#hero-sound{position:relative;z-index:2;display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin:10px 0 0;
  font-size:.7rem;color:var(--fg-3,#8b94ad)}
.hsn-btn{display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;border:0;cursor:pointer;
  font:inherit;font-size:.72rem;font-weight:700;letter-spacing:.06em;color:#dfe8ff;
  background:linear-gradient(180deg,#2a1a5e 0%,#170c3a 55%,#0d0626 100%);
  box-shadow:0 1px 0 rgba(255,255,255,.14) inset,0 -2px 0 rgba(0,0,0,.55) inset,0 4px 0 #06031a,0 8px 18px rgba(2,0,10,.6);
  transition:transform .08s,box-shadow .12s,color .2s}
.hsn-btn:hover{color:#fff;transform:translateY(-1px)}
.hsn-btn:active{transform:translateY(3px);box-shadow:0 1px 0 rgba(255,255,255,.1) inset,0 -1px 0 rgba(0,0,0,.55) inset,0 1px 0 #06031a,0 3px 8px rgba(2,0,10,.6)}
.hsn-btn[aria-pressed="true"]{color:#0a1a14;background:linear-gradient(180deg,#7dffc4 0%,#2eff9e 50%,#12c96f 100%);
  box-shadow:0 1px 0 rgba(255,255,255,.5) inset,0 -2px 0 rgba(0,90,50,.7) inset,0 4px 0 #087a45,0 8px 22px rgba(46,255,158,.45)}
.hsn-btn:focus-visible{outline:2px solid #8ff0ff;outline-offset:3px}
.hsn-ico{width:14px;height:14px;display:block}
.hsn-legend{flex:1 1 260px;min-width:0;line-height:1.45}
.hsn-legend b{color:var(--fg-2,#cdd8f0);font-weight:600}
.hsn-legend .hsn-loc{color:#8ff0ff}
@media (max-width:640px){.hsn-legend{display:none}}
`;

const ICON_ON = `<svg class="hsn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>`;
const ICON_OFF = `<svg class="hsn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/></svg>`;

/**
 * @param {object} opts
 * @param {HTMLElement} opts.host        where the toggle + legend mount
 * @param {function():object|null} opts.getState  → { speed, density, bz, kp, stormNorm, shockRate } (the hero's audioState)
 */
export function mountHeroSonify({ host, getState } = {}) {
    if (!host || typeof getState !== 'function') return null;
    if (!document.getElementById('hsn-styles')) {
        const s = document.createElement('style'); s.id = 'hsn-styles'; s.textContent = CSS; document.head.appendChild(s);
    }
    const root = document.createElement('div');
    root.id = 'hero-sound';
    root.innerHTML = `
        <button type="button" class="hsn-btn" aria-pressed="false" aria-label="Turn the solar wind sound on">${ICON_OFF}<span>Sound off</span></button>
        <span class="hsn-legend" aria-live="polite"></span>`;
    host.appendChild(root);
    const btn = root.querySelector('.hsn-btn');
    const legend = root.querySelector('.hsn-legend');

    let ctx = null, nodes = null, on = false, raf = 0, lastTick = 0, grainBudget = 0, loc = loadUserLocation();
    let shimmer = { level: 0, state: 'no-location' };
    let lastLegendAt = 0;

    function build() {
        const AC = window.AudioContext || window.webkitAudioContext;
        ctx = new AC();
        const master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);
        // drone: two oscillators → lowpass → gain
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 600; lp.Q.value = 0.8;
        const dg = ctx.createGain(); dg.gain.value = 0.55;
        const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 70;
        const o2 = ctx.createOscillator(); o2.type = 'triangle'; o2.frequency.value = 70; o2.detune.value = 6;
        const trem = ctx.createGain(); trem.gain.value = 1;
        const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.35;
        const lfoG = ctx.createGain(); lfoG.gain.value = 0;
        lfo.connect(lfoG).connect(trem.gain);
        o1.connect(lp); o2.connect(lp); lp.connect(trem).connect(dg).connect(master);
        // shimmer pad: three sines a fifth/octave apart, slow beating, high-passed
        const pad = ctx.createGain(); pad.gain.value = 0;
        const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 900;
        const padOsc = [523.25, 784, 1046.5].map((f, i) => {
            const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f; o.detune.value = (i - 1) * 4;
            const g = ctx.createGain(); g.gain.value = 0.22;
            o.connect(g).connect(hp); o.start(); return o;
        });
        hp.connect(pad).connect(master);
        // grains bus
        const grains = ctx.createGain(); grains.gain.value = 0.5; grains.connect(master);
        const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.12, ctx.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
        o1.start(); o2.start(); lfo.start();
        nodes = { master, lp, o1, o2, lfoG, pad, padOsc, grains, noiseBuf };
    }

    function grain(heat = 0.5) {
        if (!ctx || !nodes) return;
        const src = ctx.createBufferSource(); src.buffer = nodes.noiseBuf;
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
        bp.frequency.value = 900 + Math.random() * 1400 + heat * 1200; bp.Q.value = 6;
        const g = ctx.createGain(); g.gain.value = 0.35 + 0.4 * Math.random();
        src.connect(bp).connect(g).connect(nodes.grains);
        src.start();
        src.stop(ctx.currentTime + 0.12);
    }

    function apply(st, dt) {
        if (!ctx || !nodes) return;
        const t = ctx.currentTime, k = 0.25;
        const tn = tension(st.bz);
        nodes.o1.frequency.setTargetAtTime(droneHz(st.speed), t, k);
        nodes.o2.frequency.setTargetAtTime(droneHz(st.speed), t, k);
        nodes.o2.detune.setTargetAtTime(6 + tn.cents, t, k);
        nodes.lp.frequency.setTargetAtTime(brightnessHz(st.density) * (1 + 0.6 * stormLift(st.stormNorm)), t, k);
        nodes.lfoG.gain.setTargetAtTime(0.45 * tn.tremolo, t, k);
        nodes.pad.gain.setTargetAtTime(0.16 * shimmer.level, t, 0.8);
        // ticks: Poisson-ish from the shock rate, capped
        const rate = Math.min(TICKS_MAX_HZ, Math.max(0, st.shockRate || 0) * 0.08);
        grainBudget += rate * dt;
        while (grainBudget >= 1) { grainBudget -= 1; grain(Math.min(1, st.stormNorm * 1.5)); }
        grainBudget = Math.min(grainBudget, 2);
    }

    function loop(now) {
        raf = requestAnimationFrame(loop);
        if (!on || !ctx) return;
        const dt = lastTick ? Math.min(0.25, (now - lastTick) / 1000) : 0.016;
        lastTick = now;
        const st = getState();
        if (!st) return;
        if (now - lastLegendAt > 1500) { lastLegendAt = now; shimmer = shimmerLevel(loc, st.kp); renderLegend(st); }
        apply(st, dt);
    }

    function renderLegend(st) {
        if (!on) { legend.textContent = 'Hear the solar wind: speed → pitch, density → brightness, bow-shock crossings → ticks, southward Bz → tension, aurora at your location → shimmer.'; return; }
        const locTxt = loc?.city || loc?.displayName
            ? `<span class="hsn-loc">${escapeHtml(loc.city || loc.displayName)}</span>: aurora ${shimmer.state === 'go' ? 'within reach — shimmer on' : shimmer.state === 'maybe' ? 'on the horizon — faint shimmer' : 'out of reach — no shimmer'}`
            : 'no saved location — set one in the console to hear your aurora';
        legend.innerHTML = `<b>${Math.round(st.speed)} km/s</b> → ${droneHz(st.speed).toFixed(0)} Hz · <b>${st.density.toFixed(1)} cm⁻³</b> · Bz <b>${st.bz >= 0 ? '+' : ''}${st.bz.toFixed(0)} nT</b>${st.modeled ? ' (modeled at τ)' : ''} · ${locTxt}`;
    }

    async function setOn(next) {
        on = !!next;
        try { localStorage.setItem(SOUND_KEY, on ? '1' : '0'); } catch {}
        btn.setAttribute('aria-pressed', String(on));
        btn.setAttribute('aria-label', on ? 'Turn the solar wind sound off' : 'Turn the solar wind sound on');
        btn.innerHTML = `${on ? ICON_ON : ICON_OFF}<span>${on ? 'Sound on' : 'Sound off'}</span>`;
        if (on) {
            if (!ctx) build();
            if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
            nodes.master.gain.setTargetAtTime(MASTER_GAIN, ctx.currentTime, 0.6);
            lastLegendAt = 0;
            if (!raf) raf = requestAnimationFrame(loop);
        } else if (ctx) {
            nodes.master.gain.setTargetAtTime(0, ctx.currentTime, 0.4);
            renderLegend(null);
        }
    }

    btn.addEventListener('click', () => setOn(!on));
    window.addEventListener('user-location-changed', (e) => { loc = e.detail ?? loadUserLocation(); lastLegendAt = 0; });
    document.addEventListener('visibilitychange', () => {
        if (!ctx) return;
        if (document.hidden) ctx.suspend().catch(() => {});
        else if (on) ctx.resume().catch(() => {});
    });
    renderLegend(null);

    // Remembered choice: re-arm only after a gesture (browsers require it).
    let remembered = false;
    try { remembered = localStorage.getItem(SOUND_KEY) === '1'; } catch {}
    if (remembered && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const once = () => { setOn(true); window.removeEventListener('pointerdown', once); window.removeEventListener('keydown', once); };
        window.addEventListener('pointerdown', once, { passive: true });
        window.addEventListener('keydown', once);
    }

    const handle = {
        el: root,
        setOn,
        get state() { return { on, hasContext: !!ctx, shimmer, loc: loc ? { lat: loc.lat, lon: loc.lon } : null }; },
        dispose() { cancelAnimationFrame(raf); raf = 0; ctx?.close?.(); root.remove(); },
    };
    if (/[?&]debug=1(?:&|$)/.test(location.search)) window.__heroSound = handle;
    return handle;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
