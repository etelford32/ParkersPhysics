/**
 * flare-arcade.js — the 3D post-flare ARCADE and eruptive PLUME.
 * ═══════════════════════════════════════════════════════════════════════════
 * The flare geometry that extends off the disk into space: an arcade of
 * reconnected loops straddling the polarity-inversion line at the flare
 * site, and a jet of ejecta leaving along the site's radial. Both are
 * DRAWN FROM KERNEL NUMBERS ONLY — `js/flare-geometry.js` decides where the
 * site is, how the PIL is oriented, how far the feet sit apart, how high
 * the apex is, how sheared the arcade is, and how far the plume has risen
 * at a given time since onset. This module owns no physics; it owns
 * buffers, materials and a canvas dot texture.
 *
 * Consumers: sun.html (sun radius 1, full-size), solar-system.html (sun
 * radius 1.5, `heightScale` < 1 so it reads but does not dominate). The
 * caller parents `group` and ROTATES it with the site's own differential
 * rate (`siteRotation(eqAngle, latRad)` on sun.html; the sun frame on the
 * orrery) — every position here is in the site's EPOCH frame.
 *
 * The PIL is a PRIOR (Joy's law) unless `pairs` — the field atlas's real
 * conjugate footpoints from js/flare-ribbons.js — are supplied; `state.pil`
 * says which, so a HUD can disclose it.
 *
 * ── Two ways to draw a loop ──────────────────────────────────────────────
 * `style: 'line'` (the default, and what the orrery uses — its Sun is ~30 px
 * across) draws each loop as a 1 px additive `THREE.Line`. On sun.html, where
 * the arcade can fill a third of the frame, eleven hairlines seen obliquely
 * read as a coiled spring, not as plasma. `style: 'ribbon'` draws each loop as
 * a camera-facing ribbon with the PHYSICAL strand width (`strandMm`, a
 * post-flare loop strand is ~1–2 Mm across) and a pixel FLOOR — below it the
 * strand is dimmed in proportion, so a sub-pixel loop keeps its energy
 * instead of fattening (the NEO-sprite rule). The cross profile is a soft
 * tube, the along-loop profile follows the phase the kernel reports (looptop
 * source while hot, legs once it cools), and the colour is written ABOVE 1.0
 * so sun.html's HDR chain blooms it. It is a `MeshBasicMaterial` with the
 * projection and two fragment lines replaced (`onBeforeCompile`), never a raw
 * shader — the js/screen-line.js construction, for the same reason.
 * Positions, heights, shear and timing are the kernel's in BOTH styles.
 *
 * Node-gated through the kernel (tests/flare-geometry.mjs); browser gates
 * tests/sun-flare-geometry.spec.js and tests/solar-system-flare.spec.js
 * assert the drawn loops and plume against the kernel's own answers.
 */

const LOOP_SAMPLES = 24;
const RIBBON_SAMPLES = 48;
const RSUN_MM = 695.7;
/** A ribbon quad is this many strand half-widths wide: strand core + diffuse halo. */
const HALO_K = 4;

/** Shared uniforms + material factory for `style: 'ribbon'`. */
function ribbonKit(THREE, { strandMm, minPx, gain, R }) {
    const uniforms = {
        u_viewport:  { value: new THREE.Vector2(1280, 720) },    // drawing buffer, device px
        u_dpr:       { value: 1 },
        u_halfW:     { value: 0.5 * (strandMm / RSUN_MM) * R },  // world half-width of one strand
        u_minHalfPx: { value: 0.5 * minPx },
        u_tanStep:   { value: 0.004 * R },
        u_gain:      { value: gain },
        u_cool:      { value: 0 },                               // 0 hot (looptop source) → 1 cooled (legs)
    };
    const size = new THREE.Vector2();
    const onBeforeRender = (renderer) => {
        renderer.getDrawingBufferSize(size);
        uniforms.u_viewport.value.copy(size);
        uniforms.u_dpr.value = renderer.getPixelRatio();
    };
    function material() {
        const m = new THREE.MeshBasicMaterial({
            color: 0xffffff, transparent: true, opacity: 0,
            blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        });
        m.onBeforeCompile = (shader) => {
            Object.assign(shader.uniforms, uniforms);
            shader.vertexShader = shader.vertexShader
                .replace('#include <common>', `#include <common>
    attribute vec3 aTangent;
    attribute float aSide;
    attribute float aArc;
    uniform vec2 u_viewport;
    uniform float u_dpr;
    uniform float u_halfW;
    uniform float u_minHalfPx;
    uniform float u_tanStep;
    varying float vSide;
    varying float vArc;
    varying float vFloor;`)
                .replace('#include <project_vertex>', `
    vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
    vec4 clipA = projectionMatrix * mvPosition;
    vec4 clipB = projectionMatrix * (modelViewMatrix * vec4(transformed + aTangent * u_tanStep, 1.0));
    float wA = max(abs(clipA.w), 1e-5);
    vec2 sA = clipA.xy / wA * u_viewport;
    vec2 sB = clipB.xy / max(abs(clipB.w), 1e-5) * u_viewport;
    vec2 dir = sB - sA;
    dir = length(dir) > 1e-6 ? normalize(dir) : vec2(1.0, 0.0);
    vec2 nrm = vec2(-dir.y, dir.x);
    // TRUE projected half-width of the strand, device px, with a pixel floor.
    float truePx  = u_halfW * projectionMatrix[1][1] * u_viewport.y * 0.5 / wA;
    float floorPx = u_minHalfPx * u_dpr;
    // The quad is HALO_K strand-widths wide: the strand is its core and the
    // rest is the diffuse emission of the unresolved threads around it.
    float halfPx  = max(truePx, floorPx) * ${HALO_K.toFixed(1)};
    // Below the floor the ribbon is wider than the strand: dim it by the
    // ratio so the strand's energy, not its drawn width, is what is kept.
    vFloor = clamp(truePx / floorPx, 0.0, 1.0);
    vSide = aSide;
    vArc  = aArc;
    clipA.xy += nrm * aSide * (halfPx * 2.0 / u_viewport) * clipA.w;
    gl_Position = clipA;`);
            shader.fragmentShader = shader.fragmentShader
                .replace('#include <common>', `#include <common>
    uniform float u_gain;
    uniform float u_cool;
    varying float vSide;
    varying float vArc;
    varying float vFloor;`)
                .replace('#include <color_fragment>', `#include <color_fragment>
    {
        float sw    = vSide * ${HALO_K.toFixed(1)};           // strand half-widths from the spine
        float core  = exp(-sw * sw * 1.4);              // the strand itself
        float halo  = exp(-sw * sw * 0.14) * (1.0 - vSide * vSide);   // unresolved threads; zero at the quad edge
        float sA    = sin(3.14159265 * clamp(vArc, 0.0, 1.0));
        float top   = pow(sA, 1.5);                     // looptop source while hot
        float legs  = 0.50 + 0.50 * (1.0 - sA * sA);    // legs + feet once it cools
        float along = mix(top, legs, u_cool);
        diffuseColor.a   *= (core * mix(0.30, 1.0, vFloor) + 0.20 * halo) * (0.30 + 0.70 * along);
        diffuseColor.rgb *= u_gain * (1.0 + 0.8 * core);
    }`);
        };
        m.customProgramCacheKey = () => 'flare-arcade-ribbon-v1';
        return m;
    }
    return { uniforms, material, onBeforeRender };
}

function ribbonGeometry(THREE) {
    const n = RIBBON_SAMPLES + 1;
    const g = new THREE.BufferGeometry();
    const side = new Float32Array(n * 2), arc = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
        side[i * 2] = -1; side[i * 2 + 1] = 1;
        arc[i * 2] = arc[i * 2 + 1] = i / RIBBON_SAMPLES;
    }
    const index = [];
    for (let i = 0; i < RIBBON_SAMPLES; i++) {
        const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
        index.push(a, b, c, b, d, c);
    }
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
    g.setAttribute('aTangent', new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
    g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    g.setAttribute('aArc', new THREE.BufferAttribute(arc, 1));
    g.setIndex(index);
    return g;
}

function softDotTexture(THREE) {
    if (typeof document === 'undefined') return null;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0.0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
}

/**
 * @param {object} o
 * @param {object} o.THREE      the page's three.js namespace
 * @param {object} o.geometry   js/flare-geometry.js namespace (the kernel)
 * @param {number} [o.sunRadius=1]     scene radius of the photosphere
 * @param {number} [o.heightScale=1]   multiplier on drawn heights / plume reach (disclosed by the caller)
 * @param {number} [o.maxLoops=11]
 * @param {number} [o.plumeParticles=220]
 * @param {number} [o.seed=1]
 * @param {'line'|'ribbon'} [o.style='line']  how a loop is drawn (header)
 * @param {number} [o.strandMm=1.6]  ribbon: physical strand width, Mm
 * @param {number} [o.minPx=1.8]     ribbon: pixel floor on the drawn width (CSS px)
 * @param {number} [o.gain=2.2]      ribbon: HDR emission gain (values above 1 bloom)
 */
export function createFlareArcade({
    THREE, geometry, sunRadius = 1, heightScale = 1, maxLoops = 11, plumeParticles = 220, seed = 1,
    style = 'line', strandMm = 1.6, minPx = 1.8, gain = 2.2,
} = {}) {
    if (!THREE || !geometry) throw new Error('createFlareArcade: THREE and geometry are required');
    const FG = geometry;
    const R = sunRadius;
    const group = new THREE.Group();
    group.name = 'flare-arcade';
    group.visible = false;

    // ── Loops ──────────────────────────────────────────────────────────────
    const loops = [];
    const ribbon = style === 'ribbon';
    const SAMPLES = ribbon ? RIBBON_SAMPLES : LOOP_SAMPLES;
    const kit = ribbon ? ribbonKit(THREE, { strandMm, minPx, gain, R }) : null;
    for (let i = 0; ribbon && i < maxLoops; i++) {
        const mesh = new THREE.Mesh(ribbonGeometry(THREE), kit.material());
        mesh.visible = false;
        mesh.frustumCulled = false;
        mesh.onBeforeRender = kit.onBeforeRender;
        group.add(mesh);
        loops.push(mesh);
    }
    for (let i = 0; !ribbon && i < maxLoops; i++) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((LOOP_SAMPLES + 1) * 3), 3));
        const mat = new THREE.LineBasicMaterial({
            color: 0xffffff, transparent: true, opacity: 0,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });
        const line = new THREE.Line(geo, mat);
        line.visible = false;
        line.frustumCulled = false;
        group.add(line);
        loops.push(line);
    }

    // ── Plume (Points along the site radial) ───────────────────────────────
    let s = seed >>> 0 || 1;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const pu = new Float32Array(plumeParticles);
    const pphi = new Float32Array(plumeParticles);
    const prho = new Float32Array(plumeParticles);
    for (let i = 0; i < plumeParticles; i++) {
        pu[i] = Math.pow(rnd(), 0.6);          // biased toward the front
        pphi[i] = rnd() * Math.PI * 2;
        prho[i] = Math.sqrt(rnd());            // uniform over the cross-section
    }
    const plumeGeo = new THREE.BufferGeometry();
    const plumePos = new Float32Array(plumeParticles * 3);
    const plumeCol = new Float32Array(plumeParticles * 3);
    plumeGeo.setAttribute('position', new THREE.BufferAttribute(plumePos, 3));
    plumeGeo.setAttribute('color', new THREE.BufferAttribute(plumeCol, 3));
    const plumeMat = new THREE.PointsMaterial({
        size: 0.028 * R, map: softDotTexture(THREE), vertexColors: true,
        transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
        depthWrite: false, sizeAttenuation: true,
    });
    const plume = new THREE.Points(plumeGeo, plumeMat);
    plume.visible = false;
    plume.frustumCulled = false;
    group.add(plume);

    // ── State ──────────────────────────────────────────────────────────────
    let site = null;            // { latRad, lonRad0, pilAngle, cls, complex, pairs }
    let lastBuiltT = -Infinity;
    let siteVersion = 0, builtVersion = -1;
    let lastLoops = [];
    let lastPlume = { front: 1, tail: 1, radius: 0, alpha: 0, rMax: 1 };
    let lastT = 0;
    let shown = true;
    const colA = new THREE.Color(), colB = new THREE.Color(), colOut = new THREE.Color();
    const HOT  = new THREE.Color(0.55, 1.30, 1.20);   // AIA 131 teal — the shader's arcadeCol at onset
    const COOL = new THREE.Color(1.00, 0.80, 0.30);   // AIA 171 gold as the arcade cools

    function setSite(next) {
        if (!next || !Number.isFinite(next.latRad) || !Number.isFinite(next.lonRad0)) { site = null; siteVersion++; return; }
        site = {
            latRad: next.latRad,
            lonRad0: next.lonRad0,
            pilAngle: Number.isFinite(next.pilAngle) ? next.pilAngle : FG.pilAngleRad(next.latRad),
            cls: next.cls ?? 'M',
            complex: !!next.complex,
            pairs: Array.isArray(next.pairs) && next.pairs.length ? next.pairs : null,
        };
        siteVersion++;
        lastBuiltT = -Infinity;
    }

    function rebuildLoops(t) {
        lastLoops = FG.arcadeLoops({
            latRad: site.latRad, lonRad: site.lonRad0, pilAngle: site.pilAngle,
            t, cls: site.cls, n: maxLoops, complex: site.complex,
            pairs: site.pairs ? site.pairs.slice(0, maxLoops) : null, samples: SAMPLES,
        });
        for (let i = 0; i < loops.length; i++) {
            const L = lastLoops[i];
            const line = loops[i];
            if (!L) { line.visible = false; continue; }
            const arr = line.geometry.attributes.position.array;
            const stride = ribbon ? 6 : 3;      // a ribbon carries each sample twice (one per edge)
            for (let k = 0; k <= SAMPLES; k++) {
                const p = L.pts[Math.min(k, L.pts.length - 1)];
                // Heights above the photosphere scale by heightScale; the feet stay on the sphere.
                const r = p[0] * p[0] + p[1] * p[1] + p[2] * p[2];
                const rr = Math.sqrt(r);
                const drawnR = 1 + (rr - 1) * heightScale;
                const f = (drawnR / rr) * R;
                arr[k * stride] = p[0] * f; arr[k * stride + 1] = p[1] * f; arr[k * stride + 2] = p[2] * f;
                if (ribbon) { arr[k * 6 + 3] = arr[k * 6]; arr[k * 6 + 4] = arr[k * 6 + 1]; arr[k * 6 + 5] = arr[k * 6 + 2]; }
            }
            if (ribbon) {
                // Central-difference tangent along the loop, written to both edges.
                const tan = line.geometry.attributes.aTangent.array;
                for (let k = 0; k <= SAMPLES; k++) {
                    const a = Math.max(k - 1, 0) * 6, b = Math.min(k + 1, SAMPLES) * 6;
                    let tx = arr[b] - arr[a], ty = arr[b + 1] - arr[a + 1], tz = arr[b + 2] - arr[a + 2];
                    const tl = Math.hypot(tx, ty, tz) || 1;
                    tx /= tl; ty /= tl; tz /= tl;
                    tan[k * 6] = tan[k * 6 + 3] = tx; tan[k * 6 + 1] = tan[k * 6 + 4] = ty; tan[k * 6 + 2] = tan[k * 6 + 5] = tz;
                }
                line.geometry.attributes.aTangent.needsUpdate = true;
            }
            line.geometry.attributes.position.needsUpdate = true;
            line.geometry.computeBoundingSphere();
            line.userData.weight = L.weight;
            line.visible = true;
        }
        lastBuiltT = t;
        builtVersion = siteVersion;
    }

    function writePlume(ps) {
        const radial = FG.stonyhurstToUnit(site.latRad, site.lonRad0);
        const { u: ua, v: va } = FG.coneBasis(radial);
        const front = 1 + (ps.front - 1) * heightScale;
        const tail  = 1 + (ps.tail  - 1) * heightScale;
        const rad   = ps.radius * heightScale;
        for (let i = 0; i < plumeParticles; i++) {
            const u = pu[i];
            const rr = (tail + u * (front - tail)) * R;
            const w = rad * (0.3 + 0.7 * u) * prho[i] * R;
            const cx = Math.cos(pphi[i]) * w, sx = Math.sin(pphi[i]) * w;
            plumePos[i * 3]     = radial[0] * rr + ua[0] * cx + va[0] * sx;
            plumePos[i * 3 + 1] = radial[1] * rr + ua[1] * cx + va[1] * sx;
            plumePos[i * 3 + 2] = radial[2] * rr + ua[2] * cx + va[2] * sx;
            // Tail gold → front white-blue (hot ejecta ahead, cooling behind).
            const k = u;
            plumeCol[i * 3]     = 1.0 - 0.15 * k;
            plumeCol[i * 3 + 1] = 0.72 + 0.25 * k;
            plumeCol[i * 3 + 2] = 0.30 + 0.70 * k;
        }
        plumeGeo.attributes.position.needsUpdate = true;
        plumeGeo.attributes.color.needsUpdate = true;
        plumeGeo.computeBoundingSphere();
    }

    /**
     * @param {object} o
     * @param {number} o.tFlare      sim units since onset (u_flare_t)
     * @param {number} [o.intensity] impulsive flash 0..1 (u_flare_intensity)
     * @param {number} [o.showFlares=1]
     * @param {number} [o.rebuildEvery=0.5]
     */
    function update({ tFlare, intensity = 0, showFlares = 1, rebuildEvery = 0.5 } = {}) {
        lastT = tFlare;
        if (!site || !shown || !(tFlare >= 0) || tFlare > 900) { group.visible = false; return; }
        const decay = FG.ribbonDecay(tFlare);
        const ps = FG.plumeState(tFlare, site.cls);
        lastPlume = ps;
        const loopAlpha = decay * showFlares;
        if (loopAlpha < 0.01 && ps.alpha * showFlares < 0.005) { group.visible = false; return; }
        group.visible = true;

        if (builtVersion !== siteVersion || Math.abs(tFlare - lastBuiltT) >= rebuildEvery) rebuildLoops(tFlare);
        // Colour cools teal → gold on the shader's own timescale (arcadeCol, t/250).
        colA.copy(HOT); colB.copy(COOL);
        colOut.copy(colA).lerp(colB, Math.min(1, tFlare / 250));
        const flash = 0.35 + 0.65 * Math.min(1, intensity + decay);
        if (kit) kit.uniforms.u_cool.value = Math.min(1, tFlare / 250);   // the shader's own arcadeCol timescale
        for (const line of loops) {
            if (!line.visible) continue;
            line.material.color.copy(colOut);
            line.material.opacity = Math.min(1, loopAlpha * flash * (0.35 + 0.65 * (line.userData.weight ?? 1)));
        }

        if (ps.alpha * showFlares > 0.005) {
            writePlume(ps);
            plumeMat.opacity = Math.min(1, ps.alpha * showFlares);
            plume.visible = true;
        } else {
            plume.visible = false;
        }
    }

    function setVisible(v) { shown = !!v; if (!shown) group.visible = false; }

    function dispose() {
        for (const l of loops) { l.geometry.dispose(); l.material.dispose(); }
        plumeGeo.dispose(); plumeMat.map?.dispose?.(); plumeMat.dispose();
        group.parent?.remove(group);
    }

    return {
        group, setSite, update, setVisible, dispose,
        get site() { return site ? { ...site, pairs: site.pairs ? site.pairs.length : 0 } : null; },
        get state() {
            const apexR = lastLoops.length ? Math.max(...lastLoops.map(L => L.apexR)) : null;
            return {
                active: group.visible,
                t: lastT,
                loops: lastLoops.length,
                apexR,                                   // kernel R☉ (before heightScale)
                drawnApexR: apexR == null ? null : 1 + (apexR - 1) * heightScale,
                plume: { ...lastPlume, visible: plume.visible },
                pil: site ? (site.pairs ? 'atlas' : 'prior') : null,
                pilAngle: site?.pilAngle ?? null,
                heightScale,
                style: ribbon ? 'ribbon' : 'line',
                strandMm: ribbon ? strandMm : null,
                sunRadius: R,
            };
        },
    };
}
