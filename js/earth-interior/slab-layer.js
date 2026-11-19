/**
 * slab-layer.js — the plates going DOWN: USGS Slab2 surfaces inside the
 * globe, the 660 km transition zone, and today's earthquakes at their true
 * depth. Renderer only — geometry and every depth come from slabs.js (Slab2
 * node values) and the USGS feed the live view already polls.
 *
 * Drawn at TRUE scale: a slab 600 km down sits at radius 0.906. Each slab is
 * its own mesh (one vertex per baked node, triangles only inside Slab2's
 * mask), coloured by depth on ONE ramp shared with the hypocentres, with a
 * hairline every 100 km so the dip reads. The crust above turns to glass
 * (stage.setSurfaceAlpha) while this layer shows — the plates view says so.
 * The 660 km shell is drawn as glass for reference (the bottom of the
 * transition zone, where Slab2's deepest slabs stop or flatten).
 *
 * CROSS-SECTION (`setSection(code)`): the live view's 90° WEDGE, placed by
 * slabs.js `slabSection` across one slab along its OWN down-dip azimuth
 * (gated against Slab2's dip grid) and starting seaward of the trench: the
 * removed quarter is the arc side, so the slab hangs in the notch as a sheet,
 * wall A carries its profile (and the 660 km line) on PREM density, and the
 * crust is opaque again. Nothing else in the plates view may draw inside the
 * removed quarter (`isRemoved`).
 */
import * as THREE from 'three';
import { decodeSlabs, slabMesh, slabsBeneath, quakeSlabContext, slabSection, latLonToXYZ, R_EARTH_KM } from './slabs.js';
import { GlowLines, GlowPoints } from './glow-lines.js';
import { seismicSliceTable, sliceDensityColor } from './page-model.js';
import { premAt } from './prem.js';

export const DEPTH_RAMP = ['#f2e18c', '#8fd18a', '#38b1b4', '#4f7fe0', '#9a5be0', '#e05bb8'];   // 0 → 700 km
export const DEPTH_MAX_KM = 700;
/** With a section open, the slab is drawn only within this arc (rad) of the wall: 0.12 ≈ 760 km along strike. */
export const STRIP_RAD = 0.12;
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
export function depthColor(dKm) {
    const t = Math.min(1, Math.max(0, dKm / DEPTH_MAX_KM)) * (DEPTH_RAMP.length - 1);
    const i = Math.min(DEPTH_RAMP.length - 2, Math.floor(t)), f = t - i, a = hexRgb(DEPTH_RAMP[i]), b = hexRgb(DEPTH_RAMP[i + 1]);
    return a.map((v, k) => v + (b[k] - v) * f);
}
const RAMP_GLSL = `
vec3 depthRamp(float d) {
    vec3 c[${DEPTH_RAMP.length}];
${DEPTH_RAMP.map((h, i) => `    c[${i}] = vec3(${hexRgb(h).map((v) => v.toFixed(4)).join(', ')});`).join('\n')}
    float t = clamp(d / ${DEPTH_MAX_KM.toFixed(1)}, 0.0, 1.0) * ${(DEPTH_RAMP.length - 1).toFixed(1)};
    int i = int(min(floor(t), ${(DEPTH_RAMP.length - 2).toFixed(1)}));
    float f = t - float(i);
    vec3 a = c[0], b = c[1];
    for (int k = 0; k < ${DEPTH_RAMP.length - 1}; k++) { if (k == i) { a = c[k]; b = c[k + 1]; } }
    return mix(a, b, f);
}`;

const SLAB_VS = /* glsl */`
attribute float aDepth;
varying float vDepth;
varying vec3 vN;
varying vec3 vW;
void main() {
    vDepth = aDepth;
    vN = normalize(mat3(modelMatrix) * normal);
    vW = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
}`;
const SLAB_FS = /* glsl */`
${RAMP_GLSL}
uniform vec3 uKey;
uniform vec3 uCutN;
uniform float uStrip;       // > 0 with a section open: keep only the ribbon within this distance of the wall
varying float vDepth;
varying vec3 vN;
varying vec3 vW;
void main() {
    if (uStrip > 0.0 && dot(vW, uCutN) > uStrip) discard;
    vec3 n = normalize(vN);
    if (!gl_FrontFacing) n = -n;
    vec3 c = depthRamp(vDepth) * (0.42 + 0.58 * abs(dot(n, uKey)));
    // An iso-depth hairline every 100 km, one pixel wide whatever the zoom.
    float q = vDepth / 100.0, w = fwidth(q);
    float line = 1.0 - smoothstep(0.0, 1.5 * w, abs(fract(q + 0.5) - 0.5));
    c = mix(c, vec3(1.0), 0.55 * line * step(20.0, vDepth));
    gl_FragColor = vec4(c, 1.0);
}`;
const SHELL_VS = /* glsl */`
varying vec3 vN;
varying vec3 vW;
void main() { vN = normalize(mat3(modelMatrix) * normal); vW = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0); }`;
const SHELL_FS = /* glsl */`
uniform vec3 uTint;
varying vec3 vN;
varying vec3 vW;
void main() {
    float f = 1.0 - abs(dot(normalize(vN), normalize(cameraPosition - vW)));
    gl_FragColor = vec4(uTint * (0.02 + 0.30 * f * f * f), 1.0);
}`;

export async function loadSlabs(fetchFn = fetch, url = 'data/earth-interior/slab2.json.gz') {
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`Slab2: HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    const text = buf[0] === 0x1f && buf[1] === 0x8b
        ? await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
        : new TextDecoder().decode(buf);
    return decodeSlabs(JSON.parse(text));
}

export function mountSlabLayer({ stage, getQuakes = () => [] }) {
    const S = { visible: false, model: null, error: null, quakes: [], labels: [], lastQuakeKey: '' };
    const group = new THREE.Group(); group.visible = false;
    stage.scene.add(group);
    const slabMat = new THREE.ShaderMaterial({ vertexShader: SLAB_VS, fragmentShader: SLAB_FS, side: THREE.DoubleSide, uniforms: { uKey: { value: new THREE.Vector3(0, 1, 0) }, uCutN: { value: new THREE.Vector3(0, 0, 1) }, uStrip: { value: -1 } }, extensions: { derivatives: true } });
    const shell = new THREE.Mesh(new THREE.SphereGeometry((R_EARTH_KM - 660) / R_EARTH_KM, 128, 96), new THREE.ShaderMaterial({
        vertexShader: SHELL_VS, fragmentShader: SHELL_FS, uniforms: { uTint: { value: new THREE.Vector3(0.55, 0.62, 0.85) } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    shell.renderOrder = -0.6; group.add(shell);
    const hypos = new GlowPoints(); hypos.points.renderOrder = 6; group.add(hypos.points);
    stage.onResize(({ dpr }) => hypos.setDpr(dpr));
    const wallLines = new GlowLines({ width: 2.2, gain: 1.15 }); wallLines.mesh.renderOrder = 5; wallLines.mesh.visible = false; group.add(wallLines.mesh);
    stage.onResize(({ w, h, dpr }) => wallLines.setResolution(w, h, dpr));
    const P = (lat, lon, dKm) => { const r = (R_EARTH_KM - dKm) / R_EARTH_KM, u = latLonToXYZ(lat, lon); return [u[0] * r, u[1] * r, u[2] * r]; };

    function build(model) {
        for (const s of model.slabs) {
            const m = slabMesh(s), g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
            g.setAttribute('aDepth', new THREE.BufferAttribute(m.depths, 1));
            g.setIndex(new THREE.BufferAttribute(m.index, 1));
            g.computeVertexNormals();
            const mesh = new THREE.Mesh(g, slabMat); mesh.userData.code = s.code;
            group.add(mesh);
            // Label at the slab's area-mean point, lifted to the surface so it reads over the glass crust.
            const c = [0, 0, 0];
            for (let k = 0; k < m.positions.length; k += 3) { c[0] += m.positions[k]; c[1] += m.positions[k + 1]; c[2] += m.positions[k + 2]; }
            const v = new THREE.Vector3(...c).normalize();
            if (stage.labelLayer) {
                const el = document.createElement('div');
                el.className = 'ei-mlabel ei-slabel'; el.textContent = s.name; el.style.display = 'none';
                stage.labelLayer.appendChild(el);
                S.labels.push({ el, v, code: s.code });
            }
        }
    }

    function drawQuakes(force = false) {
        const qs = (getQuakes() ?? []).filter((q) => Number.isFinite(q.lat) && Number.isFinite(q.depthKm));
        const key = `${qs.length}:${qs[0]?.id ?? ''}:${qs.at(-1)?.id ?? ''}`;
        if (!force && key === S.lastQuakeKey) return;
        S.lastQuakeKey = key; S.quakes = qs;
        hypos.set(qs.map((q) => ({ p: P(q.lat, q.lon, q.depthKm), size: 4 + 2.2 * Math.max(0, (q.mag ?? 3) - 2.5), color: depthColor(q.depthKm).map((v) => v * 1.5) })));
    }

    if (stage.labelLayer) { S.wallEl = document.createElement('div'); S.wallEl.className = 'ei-mlabel ei-mlabel--layer'; S.wallEl.style.display = 'none'; stage.labelLayer.appendChild(S.wallEl); }
    stage.onFrame(() => {
        if (S.wallEl) {
            const on = S.visible && S.section && S.wallLabel;
            S.wallEl.style.display = on ? '' : 'none';
            if (on) { const v = S.wallLabel.v.clone().project(stage.camera); S.wallEl.style.transform = `translate(6px, -50%) translate(${((v.x + 1) / 2 * stage.canvas.clientWidth).toFixed(1)}px, ${((1 - v.y) / 2 * stage.canvas.clientHeight).toFixed(1)}px)`; }
        }
        if (!S.visible) return;
        const cam = stage.camera.position.clone().normalize();
        slabMat.uniforms.uKey.value.copy(cam.clone().add(new THREE.Vector3(0, 0.7, 0)).normalize());
        const w = stage.canvas.clientWidth, h = stage.canvas.clientHeight;
        for (const l of S.labels) {
            const front = l.v.dot(cam) > 0.3 && (!S.section || l.code === S.section.slab.code);
            l.el.style.display = front ? '' : 'none';
            if (!front) continue;
            const s = l.v.clone().multiplyScalar(1.004).project(stage.camera);
            l.el.style.transform = `translate(-50%, -50%) translate(${((s.x + 1) / 2 * w).toFixed(1)}px, ${((1 - s.y) / 2 * h).toFixed(1)}px)`;
        }
    });
    setInterval(() => { if (S.visible) drawQuakes(); }, 10_000);

    // Hypocentres are picked in PIXELS (the neo-watch rule): the nearest drawn point within 12 px.
    stage.addPicker((ray, p) => {
        if (!S.visible || !S.quakes.length || !p) return null;
        const w = stage.canvas.clientWidth, h = stage.canvas.clientHeight;
        let best = null, bestD = 12;
        for (const q of S.quakes) {
            const v = new THREE.Vector3(...P(q.lat, q.lon, q.depthKm)).project(stage.camera);
            if (v.z > 1) continue;
            const d = Math.hypot((v.x + 1) / 2 * w - p.px, (1 - v.y) / 2 * h - p.py);
            if (d < bestD) { bestD = d; best = q; }
        }
        return best ? { kind: 'hypocentre', quake: best } : null;
    });

    /** Is a unit-sphere direction inside the quarter a section removes? (mirrors stage.isCut for the wedge) */
    function isRemoved(p) {
        const sec = S.section; if (!sec) return false;
        const { e2, n } = sec.plane;
        return p[0] * n[0] + p[1] * n[1] + p[2] * n[2] > 0 && p[0] * e2[0] + p[1] * e2[1] + p[2] * e2[2] > 0;
    }

    /** Cut across one slab (Slab2 code), or null to close the cut. Returns the section or null. */
    function setSection(code) {
        S.section = code && S.model ? slabSection(S.model, code) : null;
        const sec = S.section;
        if (!sec) {
            slabMat.uniforms.uStrip.value = -1;
            stage.setSlice(null); wallLines.mesh.visible = false;
            stage.setSurfaceAlpha(S.visible && S.glass ? 0.42 : 1);
            return null;
        }
        const { e1, e2, n } = sec.plane;
        // A RIBBON of the slab beside the wall (STRIP_RAD of arc along strike, ~760 km): the whole half-slab in
        // the notch hid the wall and showed Slab2's ragged mask edge instead of the plunge.
        slabMat.uniforms.uCutN.value.set(...n); slabMat.uniforms.uStrip.value = STRIP_RAD;
        stage.setSlice(sec.plane, seismicSliceTable());
        stage.setDomeTints?.([3480, 1221.5].map((rKm) => ({ rKm, rgb: sliceDensityColor(premAt(rKm - 1).rhoKgM3 / 1000) })));
        stage.setSurfaceAlpha(1);
        // On wall A (the e2 half of the e1–e2 plane, its face toward +n): the slab's profile and the 660 km line.
        const onWall = (sDeg, dKm, lift = 0.0015) => {
            const a = sDeg * Math.PI / 180, r = (R_EARTH_KM - dKm) / R_EARTH_KM;
            return [0, 1, 2].map((i) => (Math.cos(a) * e1[i] + Math.sin(a) * e2[i]) * r + n[i] * lift);
        };
        const lines = [], run = [];
        const flush = () => { if (run.length > 1) lines.push({ points: run.map((p) => onWall(p.sDeg, p.depthKm)), colors: run.map((p) => depthColor(p.depthKm).map((v) => v * 1.4)) }); run.length = 0; };
        for (const p of sec.profile) { if (p.depthKm == null) flush(); else run.push(p); }
        flush();
        const span = Math.min(90, sec.lengthDeg + 4), arc = [];
        for (let t = 0; t <= span; t += 0.25) arc.push(onWall(t, 660, 0.001));
        lines.push({ points: arc, color: [0.75, 0.8, 1.0], alpha: 0.55 });
        wallLines.set(lines); wallLines.mesh.visible = true;
        S.wallLabel = { v: new THREE.Vector3(...onWall(Math.min(span, sec.lengthDeg + 2), 660, 0.004)), text: '660 km' };
        if (S.wallEl) S.wallEl.textContent = S.wallLabel.text;
        // Into the notch: look at the middle of the profile from the removed side, a little above it.
        const mid = sec.profile.filter((p) => p.depthKm != null)[Math.floor(sec.profile.filter((p) => p.depthKm != null).length / 2)];
        const tgt = onWall(mid.sDeg, 330, 0);
        const up = tgt.map((v) => v / Math.hypot(...tgt));
        // Above the trench, seaward and off to the open side: the slab's TOP surface faces up and
        // seaward, so this sees the sheet itself (from +n alone it is edge-on — the ribbon runs along n)
        // and the wall obliquely behind it.
        const off = [0, 1, 2].map((i) => n[i] * 0.45 + up[i] * 0.8 - e2[i] * 0.75), k = Math.hypot(...off);
        const dist = 0.42 + sec.lengthDeg * Math.PI / 180 * 2.2;
        stage.flyToPose(tgt.map((v, i) => v + off[i] / k * dist), tgt, { minDistance: 0.06 });
        return sec;
    }

    function setVisible(on, { glass = true } = {}) {
        S.visible = on; S.glass = glass;
        group.visible = on;
        stage.setSurfaceAlpha(on && glass && !S.section ? 0.42 : 1);
        if (!on) for (const l of S.labels) l.el.style.display = 'none';
        if (on && !S.model && !S.loading) {
            S.loading = loadSlabs().then((m) => { S.model = m; build(m); drawQuakes(true); S.onLoad?.(m); })
                .catch((err) => { S.error = err.message; S.onLoad?.(null); });
        }
        if (on) drawQuakes(true);
    }

    /** Slab context for a probe hit (surface point or hypocentre); null when there is nothing to say. */
    function describe(hit) {
        if (!S.model) return null;
        if (hit.kind === 'hypocentre') return { quake: hit.quake, ctx: quakeSlabContext(S.model, hit.quake) };
        if (hit.kind === 'surface') return { beneath: slabsBeneath(S.model, hit.lat, hit.lon) };
        return null;
    }

    return { setVisible, setSection, isRemoved, describe, get state() { return S; } };
}
