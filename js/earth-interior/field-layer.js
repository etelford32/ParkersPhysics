/**
 * field-layer.js — the stage's MAGNETIC FIELD view: CHAOS-8.1 from 1997 to
 * now, on the core and at the surface. Renderer + DOM only; every value is
 * field-model.js (CHAOS through igrf.js).
 *
 * WHAT IS DRAWN. The octant cut stays, but its faces stop at the core–mantle
 * boundary and the CORE is a ball painted with the field at its own surface
 * (the CMB): B_r or its secular change, n ≤ 13. The globe carries |B| or the
 * crustal field. The South Atlantic Anomaly's yearly position (the minimum of
 * |B|, n ≤ 13) and the geomagnetic (centred-dipole) north pole are drawn as
 * tracks on the surface, ending at the instant shown.
 *
 * TIME. One clock, the slider: CHAOS decimal years from the first sample
 * (1997.10) to today. Past the last data (2025.10) the field is CHAOS's own
 * linear forecast and every label says "forecast" — never presented as
 * observed. Maps are rebuilt only on a change of instant or quantity, at most
 * every MAP_MS while scrubbing or playing.
 */
import * as THREE from 'three';
import { GEO_GLSL } from '../geo/coords.glsl.js';
import { loadChaos, fieldMap, mapRGBA, sampleMap, fieldSummary, trackEpochs, FIELD_QUANTITIES, CMB_NMAX, yearOf } from './field-model.js';
import { GlowLines, GlowPoints } from './glow-lines.js';
import { latLonToVec, inCut } from './stage.js';
import { R_EARTH_KM } from './prem.js';

const MAP_MS = 90;
const PLAY_SECONDS = 14;
const R_CMB = 3480 / R_EARTH_KM;

const BALL_VS = /* glsl */`
varying vec3 vDir;
void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const BALL_FS = /* glsl */`
${GEO_GLSL}
uniform sampler2D uMap;
uniform float uHasMap;
uniform vec3 uKey;
varying vec3 vDir;
void main() {
    vec3 n = normalize(vDir);
    vec3 c = uHasMap > 0.5 ? texture2D(uMap, normalToUV(n)).rgb : vec3(0.35, 0.22, 0.12);
    // A gentle key so the ball reads as a sphere; the colours stay the legend's within ±15 %.
    c *= 0.85 + 0.15 * max(dot(n, uKey), 0.0);
    gl_FragColor = vec4(c, 1.0);
}`;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmtYear = (y) => {
    const ms = Date.UTC(2000, 0, 1) + (y - 2000) * 365.25 * 86400000;
    return new Date(ms).toISOString().slice(0, 7);
};

export function mountField({ stage }) {
    const S = { active: false, model: null, error: null, year: null, nowYear: yearOf(Date.now()), core: 'cmb-br', surface: 'surf-f', maps: {}, tracks: null, playing: null, pending: false, lastMap: 0 };

    // ── three.js objects ────────────────────────────────────────────────
    let ball = null, ballMat = null, saaLine = null, poleLine = null, dots = null;
    if (stage) {
        ballMat = new THREE.ShaderMaterial({ vertexShader: BALL_VS, fragmentShader: BALL_FS, uniforms: { uMap: { value: null }, uHasMap: { value: 0 }, uKey: { value: new THREE.Vector3(0, 1, 0) } } });
        ball = new THREE.Mesh(new THREE.SphereGeometry(R_CMB, 128, 96), ballMat);
        ball.visible = false; stage.scene.add(ball);
        saaLine = new GlowLines({ width: 2.4, gain: 1.1 }); poleLine = new GlowLines({ width: 2.0, gain: 1.0 });
        dots = new GlowPoints();
        for (const o of [saaLine, poleLine]) { o.mesh.visible = false; stage.scene.add(o.mesh); stage.onResize(({ w, h, dpr }) => o.setResolution(w, h, dpr)); }
        dots.points.visible = false; stage.scene.add(dots.points);
        stage.onResize(({ dpr }) => dots.setDpr(dpr));
        stage.onFrame(() => {
            if (!S.active) return;
            const cam = stage.camera.position.clone().normalize();
            ballMat.uniforms.uKey.value.copy(cam.add(new THREE.Vector3(0, 0.6, 0)).normalize());
        });
        stage.addPicker((ray) => {
            if (!S.active) return null;
            const o = ray.ray.origin, d = ray.ray.direction;
            const b = o.dot(d), c = o.lengthSq() - R_CMB * R_CMB, disc = b * b - c;
            if (disc < 0) return null;
            const q = ray.ray.at(-b - Math.sqrt(disc), new THREE.Vector3()).normalize();
            const lat = Math.asin(q.y) * 180 / Math.PI, lon = Math.atan2(-q.z, q.x) * 180 / Math.PI;
            // Visible only where the mantle is removed: the hit lies in the cut AND the ray entered through it.
            const c1 = o.lengthSq() - 1, disc1 = b * b - c1;
            const entry = disc1 >= 0 ? ray.ray.at(-b - Math.sqrt(disc1), new THREE.Vector3()) : null;
            if (!inCut(lat, lon) || (entry && !stage.isCut(entry.normalize()))) return null;
            return { kind: 'core', lat, lon };
        });
    }

    const surfPoint = (lat, lon, lift = 1.004) => latLonToVec(lat, lon).multiplyScalar(lift).toArray();

    // ── maps ────────────────────────────────────────────────────────────
    function rebuild(force = false) {
        if (!S.model || !S.active) return;
        const now = performance.now();
        if (!force && now - S.lastMap < MAP_MS) { if (!S.pending) { S.pending = true; setTimeout(() => { S.pending = false; rebuild(true); }, MAP_MS); } return; }
        S.lastMap = now;
        const core = fieldMap(S.model, S.year, S.core);
        const surf = S.surface === 'none' ? null : fieldMap(S.model, S.year, S.surface);
        S.maps = { core, surf };
        if (stage && core) {
            ballMat.uniforms.uMap.value?.dispose?.();
            const t = new THREE.DataTexture(mapRGBA(core, S.core), core.nLon, core.nLat, THREE.RGBAFormat);
            t.colorSpace = THREE.NoColorSpace; t.flipY = false; t.wrapS = THREE.RepeatWrapping; t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
            ballMat.uniforms.uMap.value = t; ballMat.uniforms.uHasMap.value = 1;
        }
        if (stage) {
            if (surf) stage.setSurfaceOverlay(mapRGBA(surf, S.surface, 214), surf.nLon, surf.nLat);
            else stage.setSurfaceOverlay(null);
        }
        drawTracks();
        renderHud();
    }

    // ── tracks: computed once, in idle chunks (each SAA search is ~40 ms) ──
    function computeTracks() {
        const epochs = trackEpochs(S.model, S.nowYear, 1);
        const out = [];
        S.tracks = out;
        let i = 0;
        const step = () => {
            const t0 = performance.now();
            while (i < epochs.length && performance.now() - t0 < 30) { out.push(fieldSummary(S.model, epochs[i])); i++; }
            drawTracks(); renderCharts();
            if (i < epochs.length) setTimeout(step, 0);
        };
        setTimeout(step, 0);
    }
    function drawTracks() {
        if (!stage || !S.tracks) return;
        const upTo = S.tracks.filter((t) => t.year <= S.year + 1e-9);
        const cur = fieldSummary(S.model, S.year);
        const all = [...upTo, cur].filter(Boolean);
        const line = (key, color) => ({
            points: all.map((t) => surfPoint(key(t)[0], key(t)[1])),
            colors: all.map((t) => (t.cover.state === 'extrapolated' ? color.map((c) => c * 0.55) : color)), alpha: 1,
        });
        saaLine.set(all.length > 1 ? [line((t) => [t.saa.latDeg, t.saa.lonDeg], [1.0, 0.95, 0.85])] : []);
        poleLine.set(all.length > 1 ? [line((t) => [t.poleLatDeg, t.poleLonDeg], [0.85, 0.95, 1.0])] : []);
        if (cur) dots.set([
            { p: surfPoint(cur.saa.latDeg, cur.saa.lonDeg), color: [1.6, 1.4, 1.1], size: 10 },
            { p: surfPoint(cur.poleLatDeg, cur.poleLonDeg), color: [1.2, 1.5, 1.8], size: 9 },
        ]);
    }

    // ── DOM ─────────────────────────────────────────────────────────────
    const slider = $('#ei-fyear');
    const chips = () => {
        for (const b of document.querySelectorAll('[data-fcore]')) b.setAttribute('aria-pressed', String(b.dataset.fcore === S.core));
        for (const b of document.querySelectorAll('[data-fsurf]')) b.setAttribute('aria-pressed', String(b.dataset.fsurf === S.surface));
    };
    const bar = (q) => {
        const Q = FIELD_QUANTITIES[q];
        const [lo, hi] = Q.range;
        return `<div class="ei-fkey"><span>${esc(Q.label)}</span><i style="background:linear-gradient(90deg,${Q.ramp.join(',')})"></i><span class="ei-fkey-ends"><span>${(lo * Q.scale).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span><span>${(hi * Q.scale).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${esc(Q.unit)}</span></span></div>`;
    };
    function renderHud() {
        const hud = $('#ei-fieldhud'); if (!hud) return;
        if (S.error) { hud.innerHTML = `<b>Magnetic field</b><span>CHAOS-8.1 unavailable (${esc(S.error)}).</span>`; return; }
        if (!S.model) { hud.innerHTML = '<b>Magnetic field</b><span>Loading CHAOS-8.1…</span>'; return; }
        const s = fieldSummary(S.model, S.year);
        const tag = s.cover.state === 'extrapolated'
            ? `<span class="ei-ftag is-forecast">forecast · ${s.cover.yearsPast.toFixed(1)} yr past the last data</span>`
            : '<span class="ei-ftag">from satellite + observatory data</span>';
        hud.innerHTML = `<b>Magnetic field · ${fmtYear(S.year)}</b>${tag}
            <span>Dipole ${(s.momentAm2 / 1e22).toFixed(3)} × 10²² A·m², tilted ${s.tiltDeg.toFixed(2)}° · pole ${s.poleLatDeg.toFixed(2)}°N ${Math.abs(s.poleLonDeg).toFixed(2)}°${s.poleLonDeg < 0 ? 'W' : 'E'}</span>
            <span>South Atlantic Anomaly ${(s.saa.fNt / 1000).toFixed(2)} µT at ${Math.abs(s.saa.latDeg).toFixed(1)}°S ${Math.abs(s.saa.lonDeg).toFixed(1)}°W</span>`;
        $('#ei-flabel').textContent = `${fmtYear(S.year)}${s.cover.state === 'extrapolated' ? ' (forecast)' : ''}`;
        $('#ei-fkeys').innerHTML = bar(S.core) + (S.surface === 'none' ? '' : bar(S.surface));
        $('#ei-fnote').textContent = `${FIELD_QUANTITIES[S.core].note} ${S.surface === 'none' ? '' : FIELD_QUANTITIES[S.surface].note}`;
    }

    // Charts: the dipole moment and the SAA's longitude through time, on one shared year axis.
    function renderCharts() {
        const host = $('#ei-fcharts'); if (!host || !S.tracks?.length) return;
        const T = S.tracks, W = 560, H = 120, L = 56, R = 12, top = 8, B = 22;
        const y0 = T[0].year, y1 = Math.max(S.nowYear, T.at(-1).year), end = S.model.end;
        const xs = (y) => L + (y - y0) / (y1 - y0) * (W - L - R);
        const panel = (title, key, unit, digits) => {
            const v = T.map(key), lo = Math.min(...v), hi = Math.max(...v), pad = (hi - lo) * 0.1 || 1;
            const ys = (x) => top + (1 - (x - lo + pad) / (hi - lo + 2 * pad)) * (H - top - B);
            const pts = (arr) => arr.map((t) => `${xs(t.year).toFixed(1)},${ys(key(t)).toFixed(1)}`).join(' ');
            const obs = T.filter((t) => t.year <= end), fc = T.filter((t) => t.year >= (obs.at(-1)?.year ?? end));
            const ticks = []; for (let y = Math.ceil(y0 / 5) * 5; y <= y1; y += 5) ticks.push(y);
            return `<svg viewBox="0 0 ${W} ${H}" class="ei-fchart" role="img" aria-label="${esc(title)} 1997 to now">
                <text x="${L}" y="${top + 4}" class="ei-ptitle">${esc(title)}</text>
                <rect x="${xs(end)}" y="${top}" width="${Math.max(0, xs(y1) - xs(end))}" height="${H - top - B}" class="ei-fc-band"/>
                ${ticks.map((y) => `<line x1="${xs(y)}" x2="${xs(y)}" y1="${H - B}" y2="${H - B + 4}" class="ei-tick"/><text x="${xs(y)}" y="${H - 6}" class="ei-ticklab" text-anchor="middle">${y}</text>`).join('')}
                <text x="${L - 6}" y="${ys(hi) + 4}" class="ei-ticklab" text-anchor="end">${hi.toFixed(digits)}</text>
                <text x="${L - 6}" y="${ys(lo) + 4}" class="ei-ticklab" text-anchor="end">${lo.toFixed(digits)}</text>
                <text x="${L - 6}" y="${(ys(lo) + ys(hi)) / 2 + 4}" class="ei-ticklab" text-anchor="end">${esc(unit)}</text>
                <polyline points="${pts(obs)}" class="ei-fc-line"/>
                ${fc.length > 1 ? `<polyline points="${pts(fc)}" class="ei-fc-line is-forecast"/>` : ''}
                <line x1="${xs(S.year)}" x2="${xs(S.year)}" y1="${top}" y2="${H - B}" class="ei-cross"/>
            </svg>`;
        };
        host.innerHTML = panel('Dipole moment', (t) => t.momentAm2 / 1e22, '10²² A·m²', 3)
            + panel('South Atlantic Anomaly — longitude of the |B| minimum', (t) => t.saa.lonDeg, '°E', 1)
            + panel('South Atlantic Anomaly — |B| at the minimum', (t) => t.saa.fNt / 1000, 'µT', 2)
            + '<p class="ei-muted ei-small">Shaded: past the last CHAOS-8.1 data (2025.10, early February 2025) — the model\'s own linear forecast, dashed.</p>';
    }

    function setYear(y, { fromSlider = false } = {}) {
        S.year = Math.min(Math.max(y, S.model?.start ?? 1997.1), S.nowYear);
        if (!fromSlider && slider) slider.value = String(S.year);
        rebuild(); renderCharts();
    }

    function wire() {
        if (slider) slider.addEventListener('input', () => { stopPlay(); setYear(Number(slider.value), { fromSlider: true }); });
        $('#ei-fnow')?.addEventListener('click', () => { stopPlay(); setYear(S.nowYear); });
        $('#ei-fplay')?.addEventListener('click', () => (S.playing ? stopPlay() : startPlay()));
        for (const b of document.querySelectorAll('[data-fcore]')) b.addEventListener('click', () => { S.core = b.dataset.fcore; chips(); rebuild(true); });
        for (const b of document.querySelectorAll('[data-fsurf]')) b.addEventListener('click', () => { S.surface = b.dataset.fsurf; chips(); rebuild(true); });
        chips();
    }
    function startPlay() {
        if (!S.model) return;
        const y0 = S.year >= S.nowYear - 0.05 ? S.model.start : S.year, t0 = performance.now();
        const span = S.nowYear - S.model.start;
        $('#ei-fplay')?.setAttribute('aria-pressed', 'true');
        const tick = (t) => {
            if (!S.playing) return;
            const y = y0 + (t - t0) / 1000 / PLAY_SECONDS * span;
            setYear(Math.min(y, S.nowYear));
            if (y >= S.nowYear) { stopPlay(); return; }
            S.playing = requestAnimationFrame(tick);
        };
        S.playing = requestAnimationFrame(tick);
    }
    function stopPlay() {
        if (S.playing) cancelAnimationFrame(S.playing);
        S.playing = null; $('#ei-fplay')?.setAttribute('aria-pressed', 'false');
    }

    async function ensureModel() {
        if (S.model || S.loading) return S.loading;
        S.loading = loadChaos().then((m) => {
            S.model = m;
            S.year = S.nowYear;
            if (slider) { slider.min = String(m.start); slider.max = String(S.nowYear); slider.step = '0.01'; slider.value = String(S.year); }
            $('#ei-fstatus') && ($('#ei-fstatus').textContent = `CHAOS-8.1 core field n ≤ 20, ${fmtYear(m.start)} → ${fmtYear(m.end)} from data; forecast to today.`);
            computeTracks(); rebuild(true);
        }).catch((err) => { S.error = err.message; renderHud(); $('#ei-fstatus') && ($('#ei-fstatus').textContent = `CHAOS-8.1 unavailable: ${err.message}`); });
        return S.loading;
    }

    function setActive(on) {
        S.active = on;
        if (stage) {
            ball.visible = on; saaLine.mesh.visible = poleLine.mesh.visible = dots.points.visible = on;
            stage.setFaceHole(on ? 3480 : null);
            stage.setFaceDim(on ? 0.42 : 1);           // the mantle recedes so the core reads
            if (!on) stage.setSurfaceOverlay(null);
        }
        if (!on) { stopPlay(); return; }
        if (stage) {
            stage.setCut('octant');
            // Look into the cut from above the South Atlantic side, so the SAA and the core are both in view.
            stage.flyToDirection(latLonToVec(22, 2), { fill: 0.86 });
        }
        renderHud();
        ensureModel().then(() => rebuild(true));
    }

    /** The probe text for a hit while this view is active (the page's #ei-probe). */
    function probe(hit) {
        if (!S.active || !S.model || !hit) return null;
        const ll = (h) => `${Math.abs(h.lat).toFixed(1)}°${h.lat < 0 ? 'S' : 'N'} ${Math.abs(h.lon).toFixed(1)}°${h.lon < 0 ? 'W' : 'E'}`;
        if (hit.kind === 'core' && S.maps.core) {
            const Q = FIELD_QUANTITIES[S.core], v = sampleMap(S.maps.core, hit.lat, hit.lon) * Q.scale;
            return `<b>Core–mantle boundary · ${ll(hit)}</b><span>${esc(Q.label)}: ${v.toFixed(Q.unit === 'mT' ? 3 : 1)} ${esc(Q.unit)} (degree ≤ ${CMB_NMAX})</span><span>2,891 km below the surface; the liquid-iron outer core starts here.</span>`;
        }
        if (hit.kind === 'surface' && S.maps.surf) {
            const Q = FIELD_QUANTITIES[S.surface], v = sampleMap(S.maps.surf, hit.lat, hit.lon) * Q.scale;
            return `<b>Surface · ${ll(hit)}</b><span>${esc(Q.label)}: ${v.toFixed(Q.unit === 'nT' ? 0 : 2)} ${esc(Q.unit)}</span>`;
        }
        return null;
    }

    wire();
    renderHud();
    return { setActive, probe, get state() { return S; } };
}
