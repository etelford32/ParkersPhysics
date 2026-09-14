/**
 * orrery-rope-layer.js — the modeled CME train drawn as FLUX-ROPE SURFACES
 * on solar-system.html.
 *
 * This replaces the page's particle burst as the thing a flare launches.
 * The particle CME recirculated its phase (`if (phase > 1) phase -= 1`) and
 * advanced on a per-frame clock capped at `min(simSpeed, 50)`, so it was a
 * steady stream over its whole radial range whose drawn position had no
 * relationship to the CME ETA printed beside it. What is drawn here is the
 * same geometric object the compounding simulator draws: the SDF zero level
 * of the ensemble's flux rope, at the apex distance the kernel says it has
 * reached at the orrery's own sim instant.
 *
 * ── This module computes NO physics ────────────────────────────────────────
 * Every rope's geometry is `corridor/corridor-model.js` `trainAt()`, which
 * probes the live kernel (`apexKmAt` / `sigmaApexKmAt` — the oracle, so the
 * train's wake and the spec §16 interaction are the kernel's answer) and
 * falls back to `stage/model.js` `ropeSpecAt`, itself a pinned mirror of the
 * Rust. The surface is `stage/model.js` `ropeSurfaceGrid`. There is no third
 * copy of the math here and there must never be one. The forecast itself is
 * the ONE shared provider's published result (`window.__fluxRopeForecast` /
 * the 'flux-rope-forecast' event) — this module never runs an ensemble.
 *
 * ── The frame join is an identity, not a conversion ───────────────────────
 * `ropeFrame(lonDeg, …)` takes STONYHURST longitude with Earth at 0, in a
 * frame whose +x is Sun→Earth and +z is ecliptic north. The orrery is y-up
 * with azimuth running +x→+z and Earth at `earthAz`. Writing the rope basis
 * into that frame (`launchBasis`) reproduces `flare-geometry.js`
 * `heliocentricSiteDirection` EXACTLY — so a rope launched from a flare
 * leaves along the azimuth the flare arcade already sits at, for free.
 * `tests/orrery-rope-layer.mjs` pins that both ways. Never add a conversion
 * here: if these two ever disagree, a flare and its own CME appear on
 * opposite limbs, which looks plausible and is completely wrong.
 *
 * ── THE SCENE IS A MIRROR OF THE ECLIPTIC, AND THE TILT PAYS FOR IT ───────
 * This page maps ecliptic (x, y, z) to world (x, z, y) — `neo-orbits.js`
 * `helioToScene`, whose swap matrix has determinant −1. The orrery's world
 * frame is therefore ORIENTATION-REVERSING with respect to the ecliptic, and
 * `launchBasis` is consequently LEFT-handed. It has to be: pinning `eDir` to
 * `heliocentricSiteDirection` fixes two of the three axes, and negating
 * either remaining one would flip east/west or north/south instead.
 *
 * Nobody notices the mirror on an orbit — every body is mirrored the same
 * way, so relative motion reads correctly. A FLUX ROPE IS DIFFERENT: its
 * tilt γ is a rotation of ê_P about ê_dir, and a mirror negates it, so a
 * rope fitted at +30° would be DRAWN at −30° — the right cloud lying the
 * wrong way across the sky, which is exactly the kind of plausible-looking
 * wrongness this repo's frames keep getting caught by. `drawTilt()` therefore
 * pre-negates γ so the page's own mirror cancels it, and the tilt a viewer
 * measures off the screen is the tilt the ensemble fitted. The surface itself
 * is not chirality-carrying (negating n̂ only re-parameterises θ), so the tilt
 * is the whole of the exposure.
 *
 * ── ROPES ARE BALLISTIC ───────────────────────────────────────────────────
 * The basis is frozen at the LAUNCH instant and never re-derived from the
 * current Earth azimuth. The drawn Earth rides a mean-motion circle, so the
 * launch azimuth is exactly `earthAz(now) − 2π·(now − launch)/yr`. Scrubbing
 * the clock therefore sweeps Earth along its orbit while the rope holds its
 * heading — the physically correct picture, and the one a static diagram
 * cannot show. Do not parent this group to anything that rotates.
 *
 * ── Radial scale: why this map and not the page's own ─────────────────────
 * solar-system.html compresses radius as `simDist(r) = 2.5 + 4.2·ln(1+1.8r)`
 * (mirrored as `neo-orbits.js` `logSceneRadius`, which the NEO spec pins
 * against the page). That map has a NON-ZERO INTERCEPT: `simDist(0) = 2.5`
 * while the Sun is drawn at radius 1.5. Applying it per-vertex is fine for a
 * point population and BREAKS a surface that reaches the origin — the rope's
 * footpoints converge toward r = 0, where direction is degenerate, so every
 * near-origin vertex is thrown onto a 2.5-radius sphere and the rope grows a
 * spherical bulb at its base. Measured before this note existed.
 *
 * So the rope carries `ropeSceneRadius`, the same curve shifted to two
 * anchors the page already owns: r = 0 lands on the Sun's DRAWN surface, and
 * r = 1 AU lands exactly on `logSceneRadius(1)`, the drawn Earth orbit —
 * because "the cloud reaches Earth" is the load-bearing claim and it has to
 * be true on screen. Between those anchors it runs slightly inside the
 * planets' own radii (Mercury's drawn orbit by ~0.4 units). That is the
 * layer's one piece of spatial dishonesty, it lives in this one function,
 * and the legend discloses it. True distances are printed in AU, never
 * scaled.
 *
 * ── Honesty ───────────────────────────────────────────────────────────────
 * An idle or failed provider draws NOTHING — never a fabricated rope. The
 * legend says which oracle drew each rope ('kernel' or the mirror fallback),
 * and a rope past 1 AU fades out rather than implying a still-inbound cloud.
 *
 * Node gate: `node tests/orrery-rope-layer.mjs` (pure half — the frame
 * identity, the radial anchors, ballistic freezing).
 * Browser gate: `tests/solar-system-rope.spec.js`.
 * Test hook: `window.__orreryRopes`.
 */

import { trainAt } from './corridor/corridor-model.js';
import { ropeSurfaceGrid } from './stage/model.js';
import { logSceneRadius } from './neo-orbits.js';

const TAU = Math.PI * 2;
const YEAR_MS = 365.25 * 86400e3;

/** Surface mesh resolution. The corridor uses 40×16; the orrery draws the
 *  rope larger and closer, so the seam shows at that density. */
export const N_PSI = 56;
export const N_THETA = 22;

/** Beyond this the front has left the scene's region of interest. */
export const PASSED_HIDE_AU = 1.35;

/** Per-rope colours — the corridor's, so the same rope reads the same across pages. */
export const ROPE_COLORS = [0xffb454, 0x4fc3f7, 0xc792ea, 0x7fe6c3, 0xff8866, 0xffd75e];

// ═══════════════════════════════════════════════════════════════════════════
//  PURE — node-gated by tests/orrery-rope-layer.mjs
// ═══════════════════════════════════════════════════════════════════════════

/** The Sun's drawn radius on solar-system.html (`SphereGeometry(1.5, …)`). */
export const SUN_DRAWN_R = 1.5;

/**
 * Heliocentric r [AU] → orrery scene radius for rope geometry.
 *
 * `logSceneRadius` shifted to pass through the Sun's drawn surface at r = 0
 * and through the page's own drawn Earth orbit at r = 1 AU:
 *
 *     ropeSceneRadius(r) = SUN_DRAWN_R + GAIN·(logSceneRadius(r) − logSceneRadius(0))
 *     GAIN = (logSceneRadius(1) − SUN_DRAWN_R) / (logSceneRadius(1) − logSceneRadius(0))
 *
 * Read the header's "Radial scale" note before changing either anchor.
 */
export const ROPE_SCALE_GAIN =
    (logSceneRadius(1) - SUN_DRAWN_R) / (logSceneRadius(1) - logSceneRadius(0));

export function ropeSceneRadius(rAu) {
    if (!(rAu > 0)) return SUN_DRAWN_R;
    return SUN_DRAWN_R + ROPE_SCALE_GAIN * (logSceneRadius(rAu) - logSceneRadius(0));
}

/**
 * The rope frame's basis written in orrery world coordinates (y-up, azimuth
 * from +x toward +z), for an Earth sitting at `earthAzRad`.
 *
 * Applying this to `ropeFrame(lon, lat, 0).eDir` reproduces
 * `flare-geometry.js heliocentricSiteDirection({latRad, lonRad, earthAzRad,
 * spinSign})` exactly — see the header. `spinSign` is the sense the DRAWN Sun
 * spins in that azimuth (+1: azimuth increasing), because west is by
 * definition the direction of rotation.
 *
 * @returns {{e1:number[], e2:number[], e3:number[], azRad:number}}
 */
/**
 * The tilt to BUILD a rope frame with, so the tilt a viewer measures off this
 * page equals `tiltDeg` — see the header's mirror note. Pure and its own
 * function so the sign lives in exactly one place.
 */
export function drawTilt(tiltDeg) {
    return -(tiltDeg ?? 0);
}

/**
 * A draw-time copy of a rope with its tilt pre-mirrored. Everything else is
 * passed through untouched, so `trainAt` still probes the kernel by index and
 * the kinematics are the oracle's.
 */
export function drawRope(rope) {
    return { ...rope, tiltDeg: drawTilt(rope?.tiltDeg) };
}

export function launchBasis(earthAzRad = 0, spinSign = 1) {
    const A = earthAzRad;
    const s = Math.sign(spinSign || 1);
    const cA = Math.cos(A), sA = Math.sin(A);
    return {
        e1: [cA, 0, sA],                 // rope +x — Sun→Earth at launch
        e2: [-s * sA, 0, s * cA],        // rope +y — completes the ecliptic pair
        e3: [0, 1, 0],                   // rope +z — ecliptic north
        azRad: A,
        // e1×e2 = −e3: LEFT-handed, and deliberately so. See the header's
        // mirror note — this is the page's convention, not a sign slip, and
        // `drawTilt` is what pays for it.
        handedness: -1,
    };
}

/**
 * Earth's DRAWN azimuth at `launchMs`, given its azimuth now.
 *
 * The drawn Earth rides a mean-motion circle (one turn per 365.25 d), so this
 * is exact for the thing actually on screen — which is what the rope has to
 * arrive at. Freezing the basis here is what keeps the rope ballistic.
 */
export function earthAzAtLaunch(earthAzNowRad, nowMs, launchMs) {
    if (!Number.isFinite(launchMs) || !Number.isFinite(nowMs)) return earthAzNowRad;
    return earthAzNowRad - TAU * (nowMs - launchMs) / YEAR_MS;
}

/**
 * One rope-frame point (AU) → orrery scene coordinates.
 *
 * The basis is orthonormal, so the rotated vector keeps its length and the
 * physical radius is just |p| — no need to re-measure after rotating.
 */
export function ropePointToScene(p, basis, out = [0, 0, 0]) {
    const { e1, e2, e3 } = basis;
    const x = p[0] * e1[0] + p[1] * e2[0] + p[2] * e3[0];
    const y = p[0] * e1[1] + p[1] * e2[1] + p[2] * e3[1];
    const z = p[0] * e1[2] + p[1] * e2[2] + p[2] * e3[2];
    const rAu = Math.hypot(p[0], p[1], p[2]);
    if (!(rAu > 1e-12)) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
    const k = ropeSceneRadius(rAu) / rAu;
    out[0] = x * k; out[1] = y * k; out[2] = z * k;
    return out;
}

/**
 * Map a whole `ropeSurfaceGrid` positions array into scene coordinates.
 * Writes into `dst` when supplied so the per-frame rebuild allocates nothing.
 */
export function mapSurface(positions, basis, dst = null) {
    const out = dst && dst.length === positions.length ? dst : new Float32Array(positions.length);
    const p = [0, 0, 0], q = [0, 0, 0];
    for (let i = 0; i < positions.length; i += 3) {
        p[0] = positions[i]; p[1] = positions[i + 1]; p[2] = positions[i + 2];
        ropePointToScene(p, basis, q);
        out[i] = q[0]; out[i + 1] = q[1]; out[i + 2] = q[2];
    }
    return out;
}

/** Opacity ramp past 1 AU — a front that has gone by must stop implying it is inbound. */
export function passedFade(apexAu) {
    if (!(apexAu > 1)) return 1;
    return Math.max(0, 1 - (apexAu - 1) / (PASSED_HIDE_AU - 1));
}

// ═══════════════════════════════════════════════════════════════════════════
//  RENDERER
// ═══════════════════════════════════════════════════════════════════════════

const CSS = `
.orl-legend {
    position:absolute; right:12px; bottom:52px; z-index:22;
    background:rgba(4,3,14,.82); backdrop-filter:blur(8px);
    border:1px solid rgba(255,180,84,.26); border-radius:8px;
    padding:7px 10px 8px; font:10px/1.55 system-ui,-apple-system,sans-serif;
    color:#cfd6e6; max-width:250px; pointer-events:none;
}
.orl-legend .orl-hd { font-weight:700; letter-spacing:.1em; font-size:9.5px;
    color:#ffc978; margin-bottom:3px; }
.orl-legend .orl-row { display:flex; align-items:baseline; gap:6px; }
.orl-legend .orl-chip { width:8px; height:8px; border-radius:2px; flex:0 0 auto;
    transform:translateY(1px); }
.orl-legend .orl-note { color:#77809a; font-size:9px; margin-top:4px; line-height:1.45; }
@media (max-width:900px) { .orl-legend { display:none; } }
`;

/**
 * @param {object} opts
 * @param {object} opts.THREE          three.js namespace (injected, like flare-arcade)
 * @param {object} opts.scene          the orrery scene
 * @param {function():number} opts.getEarthAz  drawn Earth azimuth NOW, radians
 * @param {number} [opts.spinSign]     the drawn Sun's spin sense (+1 on this page)
 * @param {HTMLElement} [opts.host]    legend parent
 */
export function createOrreryRopeLayer({ THREE, scene, getEarthAz, spinSign = 1, host = null } = {}) {
    if (!THREE || !scene) throw new Error('createOrreryRopeLayer: THREE and scene are required');

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const legend = document.createElement('div');
    legend.className = 'orl-legend';
    legend.id = 'orrery-rope-legend';
    legend.style.display = 'none';
    (host ?? document.body).appendChild(legend);

    const group = new THREE.Group();
    group.name = 'cme-flux-rope-train';
    scene.add(group);

    /** @type {null|object} the published forecast we are drawing */
    let fc = null;
    /** The same preset with every rope's tilt pre-mirrored for this page. */
    let drawPreset = null;
    /** @type {Array} per-rope draw state */
    let ropes = [];
    let userVisible = true;
    let lastKey = '';
    let lastLegendAt = 0;
    const LEGEND_MS = 500;

    function disposeRopes() {
        for (const r of ropes) {
            group.remove(r.root);
            r.mesh.geometry.dispose(); r.mesh.material.dispose();
            r.wire.geometry.dispose(); r.wire.material.dispose();
            r.nose.geometry.dispose(); r.nose.material.dispose();
            r.trail.geometry.dispose(); r.trail.material.dispose();
        }
        ropes = [];
    }

    function applyVisibility() {
        const live = !!(fc && !fc.idle && !fc.failed && ropes.length);
        group.visible = userVisible && live;
        legend.style.display = group.visible ? '' : 'none';
    }

    /** Adopt a published forecast. Builds one draw slot per rope in the train. */
    function adopt(next) {
        disposeRopes();
        fc = next && !next.idle && !next.failed && next.preset ? next : null;
        drawPreset = null;
        lastKey = '';
        if (!fc) { applyVisibility(); return; }

        const list = fc.preset.ropes?.length ? fc.preset.ropes : (fc.preset.rope ? [fc.preset.rope] : []);
        drawPreset = { ...fc.preset, ropes: list.map(drawRope), rope: undefined };
        const nowMs = Date.now();
        const azNow = getEarthAz ? getEarthAz() : 0;

        list.forEach((rope, i) => {
            const color = ROPE_COLORS[i % ROPE_COLORS.length];
            const launchMs = fc.launchMs + (rope.launchOffsetS ?? 0) * 1000;
            // BALLISTIC: the basis is frozen at this rope's own launch instant.
            const basis = launchBasis(earthAzAtLaunch(azNow, nowMs, launchMs), spinSign);

            // Index buffer and vertex count are fixed by (N_PSI, N_THETA); only
            // the positions move, so the geometry is allocated once per rope.
            const seed = ropeSurfaceGrid(
                { frame: { eDir: [1, 0, 0], eP: [0, 1, 0], nHat: [0, 0, 1] }, dAu: 1, sigApexAu: 0.1 },
                N_PSI, N_THETA);
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(seed.positions.length), 3));
            geo.setIndex(new THREE.BufferAttribute(seed.indices, 1));

            const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
                color, transparent: true, opacity: 0.30,
                side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
            }));
            mesh.renderOrder = 6;
            const wire = new THREE.LineSegments(
                new THREE.BufferGeometry(),
                new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.18, depthWrite: false }));
            wire.renderOrder = 7;

            const nose = new THREE.Mesh(
                new THREE.SphereGeometry(0.055, 14, 10),
                new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false }));
            nose.renderOrder = 8;

            // Radial trail from the Sun's drawn surface to the apex, along the
            // rope's own heading — the launch site, drawn where the arcade is.
            const trail = new THREE.Line(
                new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
                new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.34, depthWrite: false }));

            const root = new THREE.Group();
            root.visible = false;
            root.add(mesh, wire, nose, trail);
            group.add(root);

            ropes.push({
                root, mesh, wire, nose, trail, color, rope, basis, launchMs,
                index: i, cme: fc.cmes?.[i] ?? null,
                scratch: new Float32Array(seed.positions.length),
                apexAu: NaN, oracle: null,
            });
        });
        applyVisibility();
    }

    // three.js Groups default to visible:true, so an empty layer would report
    // itself visible until the first forecast landed — a layer that claims to
    // be drawing nothing while saying it is on. Settle it at construction.
    applyVisibility();

    window.addEventListener('flux-rope-forecast', (ev) => adopt(ev.detail), { passive: true });
    if (window.__fluxRopeForecast) adopt(window.__fluxRopeForecast);

    /**
     * Place the train at the orrery's sim instant.
     * @param {number} simMs the page's own sim clock, so scrubbing replays the transit
     */
    function update(simMs) {
        if (!group.visible || !fc || !Number.isFinite(simMs)) return;
        // The surface only moves when the clock does; a paused orrery costs nothing.
        const key = Math.round(simMs / 1000) + ':' + ropes.length;
        const wantLegend = performance.now() - lastLegendAt >= LEGEND_MS;
        if (key === lastKey && !wantLegend) return;
        lastKey = key;

        // The preset's ropes go in with their tilt pre-mirrored (see the header):
        // `trainAt` builds the frame, so the negation has to reach it, and it
        // probes the kernel by INDEX so the kinematics are untouched.
        const train = trainAt(drawPreset, fc.launchMs, simMs, fc.kernel);
        const byIndex = new Map(train.map(m => [m.index, m]));
        const rows = [];

        for (const r of ropes) {
            const m = byIndex.get(r.index);
            if (!m) {
                r.root.visible = false;
                r.apexAu = NaN; r.oracle = null;
                rows.push({ r, txt: `launches ${fmtUtc(r.launchMs)}Z` });
                continue;
            }
            const apexAu = m.geometry.dAu;
            r.apexAu = apexAu; r.oracle = m.geometry.oracle;
            if (apexAu >= PASSED_HIDE_AU) {
                r.root.visible = false;
                rows.push({ r, txt: 'passed L1' });
                continue;
            }
            r.root.visible = true;

            const { positions } = ropeSurfaceGrid(m.geometry, N_PSI, N_THETA);
            mapSurface(positions, r.basis, r.scratch);
            const attr = r.mesh.geometry.attributes.position;
            attr.array.set(r.scratch);
            attr.needsUpdate = true;
            r.mesh.geometry.computeVertexNormals();
            r.mesh.geometry.computeBoundingSphere();

            // Wireframe is rebuilt from the live surface — cheap at this density
            // and the only way the seam follows the deforming rope.
            r.wire.geometry.dispose();
            r.wire.geometry = new THREE.WireframeGeometry(r.mesh.geometry);

            const eDir = m.geometry.frame.eDir;
            const tip = [0, 0, 0];
            ropePointToScene([eDir[0] * apexAu, eDir[1] * apexAu, eDir[2] * apexAu], r.basis, tip);
            r.nose.position.set(tip[0], tip[1], tip[2]);

            const tp = r.trail.geometry.attributes.position;
            // The trail leaves the Sun's drawn surface along the rope's heading.
            const fx = eDir[0] * r.basis.e1[0] + eDir[1] * r.basis.e2[0] + eDir[2] * r.basis.e3[0];
            const fy = eDir[0] * r.basis.e1[1] + eDir[1] * r.basis.e2[1] + eDir[2] * r.basis.e3[1];
            const fz = eDir[0] * r.basis.e1[2] + eDir[1] * r.basis.e2[2] + eDir[2] * r.basis.e3[2];
            tp.setXYZ(0, fx * SUN_DRAWN_R, fy * SUN_DRAWN_R, fz * SUN_DRAWN_R);
            tp.setXYZ(1, tip[0], tip[1], tip[2]);
            tp.needsUpdate = true;
            r.trail.geometry.computeBoundingSphere();

            const fade = passedFade(apexAu);
            r.mesh.material.opacity = 0.30 * fade;
            r.wire.material.opacity = 0.18 * fade;
            r.nose.material.opacity = 0.95 * fade;
            r.trail.material.opacity = 0.34 * fade;

            const v = fc.kernel?.apexVKmsAt ? Math.round(fc.kernel.apexVKmsAt(r.index, m.geometry.tS)) : null;
            rows.push({ r, txt: `apex ${apexAu.toFixed(2)} AU${v ? ` · ${v} km/s` : ''}` });
        }

        if (wantLegend) { lastLegendAt = performance.now(); renderLegend(rows, simMs); }
    }

    function fmtUtc(ms) {
        return Number.isFinite(ms) ? new Date(ms).toISOString().slice(5, 16).replace('T', ' ') : '—';
    }

    function renderLegend(rows, simMs) {
        const chips = rows.map(({ r, txt }) => {
            const hex = '#' + r.color.toString(16).padStart(6, '0');
            const kms = Math.round(r.cme?.speedKms ?? r.rope.v0Kms ?? 0);
            return `<div class="orl-row"><span class="orl-chip" style="background:${hex}"></span>
                R${r.index} · ${fmtUtc(r.launchMs)}Z · ${kms} km/s → ${txt}</div>`;
        }).join('');
        const mirrored = rows.some(({ r }) => r.oracle === 'mirror');
        legend.innerHTML = `
            <div class="orl-hd">CME TRAIN · FLUX-ROPE TRANSIT</div>
            ${chips}
            <div class="orl-note">Surface = ensemble rope at ±1σ apex, from the flux-rope
            kernel${mirrored ? ' (some ropes on the mirror fallback)' : ''} · t = ${fmtUtc(simMs)}Z<br>
            Radial scale compressed: the Sun's drawn surface is 0 AU and the drawn Earth orbit
            is 1 AU, so inner radii run inside the planets'. AU readouts are true. Ropes are
            ballistic — they do not co-rotate.</div>`;
    }

    const handle = {
        group,
        update,
        adopt,
        setVisible(v) { userVisible = !!v; applyVisibility(); },
        /** True while a rope is actually on screen — the page suppresses its
         *  particle burst on this, so the two never contradict each other. */
        get active() { return group.visible && ropes.some(r => r.root.visible); },
        get state() {
            return {
                live: !!fc, idle: fc ? false : true, userVisible,
                groupVisible: group.visible, ropeCount: ropes.length,
                drawn: ropes.filter(r => r.root.visible).length,
                apexAu: ropes.map(r => r.apexAu),
                oracle: ropes.map(r => r.oracle),
                azRad: ropes.map(r => r.basis.azRad),
                scaleGain: ROPE_SCALE_GAIN,
            };
        },
        dispose() { disposeRopes(); scene.remove(group); legend.remove(); style.remove(); },
    };
    window.__orreryRopes = handle;
    return handle;
}
