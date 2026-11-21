/**
 * flare-rope.js — the erupting flux rope, drawn (THREE injected; no physics)
 * ═══════════════════════════════════════════════════════════════════════════
 * The view of `ropeState` / `ropeStrands` in js/flare-geometry.js. Like
 * js/flare-arcade.js it draws kernel numbers and decides nothing: where the
 * rope's feet are (inside the ribbons' hooks), how high its apex is at this
 * instant (a slow rise, an acceleration, a coast), how wide it is, how its
 * field winds about its axis and which way — all of that is the model's, and
 * is what js/flare-realism.js scores.
 *
 * NOT THE OLD TUBE. sun.html carries two owner-disabled eruption visuals
 * (`spawnFluxRope`, a torus mesh, and `spawnEruptingProminence`, a bubble).
 * They stay disabled. This is a different object, asked for on 2026-11-21:
 * strands of the model's own field, anchored where the model's ribbons hook.
 *
 * WHAT IS DRAWN. Each strand is a camera-facing ribbon of physical width
 * (the arcade's own strand material — one look for one plasma). Two
 * families, because a rope is seen as two different things:
 *
 *   hot   the "hot channel" — a rope is a ~10 MK structure in AIA 131 / 94 Å
 *         before and as it erupts (Zhang, Cheng & Ding 2012);
 *   cool  the filament material riding in it — dark on the disc in the
 *         coronal channels, bright red off the limb in 304 Å and Hα.
 *
 * The page says how much of each a view shows (`weights`); this module does
 * not know what a channel is.
 *
 * BRIGHTNESS FALLS AS IT EXPANDS. An optically thin structure's surface
 * brightness goes as n²·depth; self-similar expansion by a factor s dilutes
 * that by s⁻⁵. Drawn that way the rope would vanish within one frame of the
 * acceleration, so the drawn law is a DISCLOSED display compression,
 * (h0 / h)^DILUTION, and the rope is gone by the radius the model says
 * (`fadeR`): past that the corona on this page is OBSERVED (LASCO), and a
 * modelled CME is not painted over an observation.
 *
 * DILUTION is 0.6. It was 1 until the camera learned to follow the rope out
 * (CAM.eruptionShot): at 1 the rope was down to 5 % of its starting
 * brightness with its apex at 1.9 R☉ — the shot pulled back to frame
 * something that could no longer be seen (measured on the first capture).
 * At 0.6 it is 17 % there. Neither number is physics; both are far gentler
 * than the s⁻⁵ they stand in for, and the legend's wording is "brightness
 * compressed".
 *
 * THE THREADS WIDEN WITH THE ROPE. A strand is a bundle of field; when the
 * rope expands, so does it. Self-similar expansion would widen it in step
 * with the apex height; the drawn law is (h / h0)^STRAND_EXPANSION with 0.7 —
 * sub-linear, so the rope keeps its threaded look. At a fixed 1.6 Mm the
 * strands were sub-pixel hairlines by the time the camera had pulled back,
 * and the strand shader (rightly) dims a sub-pixel strand by its true width:
 * the rope went out twice over.
 *
 * THE CURRENT SHEET. Under an erupting rope the field reconnects in a thin
 * hot layer between the arcade's top and the rope's underside. It is drawn as
 * a fan of faint hot lines (kernel `sheetStrands`) along which blobs stream
 * AWAY from the reconnection point, down onto the arcade and up into the rope
 * (kernel `sheetState.phase`, the strand shader's flow mode 2). It is a hot
 * structure: a view shows it with its `hot` weight.
 *
 * THE FILAMENT DRAINS. As the rope leaves, its cool material runs back down
 * the legs (kernel `ropeDrain`, flow mode 1 on the filament strands).
 *
 * TWO KINDS OF STRAND, from the kernel: field lines on nested shells
 * (`cool: false`) and the filament bundle in the rope's underside
 * (`cool: true`, see ropeStrands). Each carries its own `weight`; this file
 * multiplies, it does not choose.
 */

import { ribbonKit, ribbonGeometry } from './flare-arcade.js';

/** How the rope's surface brightness is drawn to fall with its apex height: (h0/h)^DILUTION. A display choice. */
export const DILUTION = 0.6;
/** How a strand's drawn WIDTH grows with the apex height: (h/h0)^STRAND_EXPANSION (1 = self-similar). A display choice. */
export const STRAND_EXPANSION = 0.7;
/** The current sheet's brightness beside a rope strand's. A display choice: a sheet is far fainter than the rope it feeds. */
export const SHEET_GAIN = 0.4;

/**
 * @param {object} o
 * @param {object} o.THREE
 * @param {object} o.geometry        js/flare-geometry.js (module) — its FLARE_MODEL is the default law
 * @param {number} [o.sunRadius=1]
 * @param {number} [o.strands=24]    strands drawn (two in three are field lines, one in three the filament)
 * @param {number} [o.samples=96]    points per strand
 * @param {number} [o.strandMm=1.6]  physical strand width, Mm
 * @param {number} [o.minPx=1.4]     pixel floor on the drawn width (CSS px)
 * @param {number} [o.gain=1.0]      HDR emission gain
 */
export function createFlareRope({
    THREE, geometry, sunRadius = 1, strands = 24, samples = 96, strandMm = 1.6, minPx = 1.4, gain = 1.0,
    sheetLines = 13, sheetSamples = 24,
} = {}) {
    if (!THREE || !geometry) throw new Error('createFlareRope: THREE and geometry are required');
    const FG = geometry;
    let LAW = geometry.FLARE_MODEL ?? geometry;
    const R = sunRadius;
    const group = new THREE.Group();
    group.name = 'flare-rope';
    group.visible = false;

    const kit = ribbonKit(THREE, { strandMm, minPx, gain, R, flowGlsl: FG.STRAND_FLOW_GLSL ?? '' });
    const halfW0 = kit.uniforms.u_halfW.value;
    const HOT  = new THREE.Color(0.39, 0.92, 0.85);    // the arcade's hot strand colour (131 Å teal), same luminance
    const COOL = new THREE.Color(1.00, 0.42, 0.16);    // 304 Å / Hα: filament material
    const meshes = [];
    for (let i = 0; i < strands; i++) {
        const mesh = new THREE.Mesh(ribbonGeometry(THREE, samples), kit.material());
        mesh.frustumCulled = false;
        mesh.onBeforeRender = kit.onBeforeRender;
        mesh.visible = false;
        group.add(mesh);
        meshes.push(mesh);
    }

    // The current sheet: its own strands (shorter polylines), same material.
    const sheet = [];
    for (let i = 0; i < sheetLines; i++) {
        const mesh = new THREE.Mesh(ribbonGeometry(THREE, sheetSamples), kit.material());
        mesh.frustumCulled = false;
        mesh.onBeforeRender = kit.onBeforeRender;
        mesh.visible = false;
        group.add(mesh);
        sheet.push(mesh);
    }
    function writeStrand(mesh, pts, n) {
        const pos = mesh.geometry.attributes.position.array, tan = mesh.geometry.attributes.aTangent.array;
        for (let k = 0; k <= n; k++) {
            const p = pts[k];
            pos[k * 6] = pos[k * 6 + 3] = p[0] * R; pos[k * 6 + 1] = pos[k * 6 + 4] = p[1] * R; pos[k * 6 + 2] = pos[k * 6 + 5] = p[2] * R;
        }
        for (let k = 0; k <= n; k++) {
            const a = Math.max(k - 1, 0) * 6, b = Math.min(k + 1, n) * 6;
            let tx = pos[b] - pos[a], ty = pos[b + 1] - pos[a + 1], tz = pos[b + 2] - pos[a + 2];
            const tl = Math.hypot(tx, ty, tz) || 1;
            tx /= tl; ty /= tl; tz /= tl;
            tan[k * 6] = tan[k * 6 + 3] = tx; tan[k * 6 + 1] = tan[k * 6 + 4] = ty; tan[k * 6 + 2] = tan[k * 6 + 5] = tz;
        }
        mesh.geometry.attributes.position.needsUpdate = true;
        mesh.geometry.attributes.aTangent.needsUpdate = true;
        mesh.geometry.computeBoundingSphere();
    }

    let site = null, shown = true, last = null, lastT = 0, eruptiveNow = false, flowOn = true, lastSheet = null, lastDrain = null;

    function setSite(next) {
        if (!next || !Number.isFinite(next.latRad) || !Number.isFinite(next.lonRad0)) { site = null; return; }
        site = {
            latRad: next.latRad, lonRad0: next.lonRad0,
            pilAngle: Number.isFinite(next.pilAngle) ? next.pilAngle : FG.pilAngleRad(next.latRad),
            cls: next.cls ?? 'M', chirality: next.chirality < 0 ? -1 : 1,
        };
    }
    function setModel(m) { LAW = m ?? (FG.FLARE_MODEL ?? FG); }
    function setVisible(v) { shown = !!v; if (!shown) group.visible = false; }
    function setGain(g) { if (Number.isFinite(g)) kit.uniforms.u_gain.value = g; }

    /**
     * @param {object} o
     * @param {number} o.tFlare       sim units since onset
     * @param {number} [o.showFlares=1]
     * @param {boolean} [o.eruptive=true]  the page's call: a confined flare has no rope
     * @param {{hot:number, cool:number}} [o.weights]  how much of each strand family this view shows
     */
    function update({ tFlare, showFlares = 1, eruptive = true, weights = { hot: 1, cool: 1 } } = {}) {
        lastT = tFlare; eruptiveNow = !!eruptive;
        const st = (site && LAW.ropeState) ? LAW.ropeState(tFlare, site.cls) : null;
        last = st;
        if (!st || !st.active || !eruptive || !shown || !(st.alpha * showFlares > 0.004)) { group.visible = false; lastSheet = null; lastDrain = null; return; }
        const drain = flowOn && LAW.ropeDrain ? LAW.ropeDrain({ latRad: site.latRad, lonRad: site.lonRad0, pilAngle: site.pilAngle, t: tFlare, cls: site.cls, chirality: site.chirality }) : null;
        lastDrain = drain;
        const lines = LAW.ropeStrands({ latRad: site.latRad, lonRad: site.lonRad0, pilAngle: site.pilAngle, t: tFlare, cls: site.cls,
            chirality: site.chirality, n: strands, samples });
        const dim = Math.pow(st.h0 / st.apexH, DILUTION);
        kit.uniforms.u_halfW.value = halfW0 * Math.pow(Math.max(1, st.apexH / st.h0), STRAND_EXPANSION);
        for (let i = 0; i < meshes.length; i++) {
            const mesh = meshes[i], L = lines[i];
            const w = L ? (L.cool ? weights.cool : weights.hot) : 0;
            const op = L ? Math.min(1, st.alpha * showFlares * dim * w * L.weight) : 0;
            if (!(op > 0.003)) { mesh.visible = false; continue; }
            writeStrand(mesh, L.pts, samples);
            // The filament drains down the rope's legs; the field lines carry no pattern.
            if (L.cool && drain && drain.rain > 0) { mesh.material.userData.flow.value.set(1, 2, drain.rain, drain.rainPhase + i * 0.37); mesh.material.userData.flowK.value = drain.clumps; }
            else mesh.material.userData.flow.value.set(0, 2, 0, 0);
            mesh.material.color.copy(L.cool ? COOL : HOT);
            mesh.material.opacity = op;
            // The strand shader's along-loop profile: even along the whole strand (0.5 mixes its "top" and "legs" shapes).
            if (mesh.material.userData.cool) mesh.material.userData.cool.value = 0.5;
            mesh.visible = true;
        }
        // ── The current sheet between the arcade's top and the rope's underside ──
        const ss = flowOn && LAW.sheetState ? LAW.sheetState(tFlare, site.cls) : null;
        const sheetNow = ss && ss.active && ss.alpha > 0.01
            ? LAW.sheetStrands({ latRad: site.latRad, lonRad: site.lonRad0, pilAngle: site.pilAngle, t: tFlare, cls: site.cls, chirality: site.chirality, n: sheetLines, samples: sheetSamples })
            : [];
        // A sheet is thin and faint beside the rope it feeds, and it thins as it is stretched (÷ √ its length in units of the rope's start height).
        const sheetDim = ss ? Math.min(1, Math.pow(st.h0 / Math.max(ss.length, st.h0), 0.5)) : 0;
        let drawn = 0;
        for (let i = 0; i < sheet.length; i++) {
            const mesh = sheet[i], S = sheetNow[i];
            const op = S ? Math.min(1, ss.alpha * showFlares * weights.hot * SHEET_GAIN * sheetDim * S.weight) : 0;
            if (!(op > 0.003)) { mesh.visible = false; continue; }
            writeStrand(mesh, S.pts, sheetSamples);
            mesh.material.color.copy(HOT);
            mesh.material.opacity = op;
            if (mesh.material.userData.cool) mesh.material.userData.cool.value = 0.5;
            mesh.material.userData.flow.value.set(2, ss.x, 1, ss.phase + i * 0.29);
            mesh.material.userData.flowK.value = ss.clumps;
            mesh.visible = true; drawn++;
        }
        lastSheet = ss ? { active: drawn > 0, lines: drawn, lowH: ss.lowH, highH: ss.highH, phase: ss.phase, x: ss.x, rate: ss.rate, alpha: ss.alpha } : null;
        group.visible = true;
    }

    /** The flows (filament drainage, the current sheet) on/off: the A/B and the gates' control. */
    function setFlowEnabled(on) { flowOn = !!on; if (!flowOn) for (const m of sheet) m.visible = false; }

    function dispose() {
        for (const m of meshes) { m.geometry.dispose(); m.material.dispose(); }
        for (const m of sheet) { m.geometry.dispose(); m.material.dispose(); }
    }

    return {
        group, setSite, setModel, setVisible, setGain, setFlowEnabled, update, dispose,
        get site() { return site ? { ...site } : null; },
        get state() {
            return {
                active: group.visible, t: lastT, eruptive: eruptiveNow,
                apexR: last ? last.apexR : null, apexH: last ? last.apexH : null, minorR: last ? last.minorR : null,
                speed: last ? last.speed : null, alpha: last ? last.alpha : null,
                strands: meshes.filter((m) => m.visible).length, count: meshes.length, samples,
                // The flows: the current sheet under the rope, and the filament draining down its legs.
                sheet: lastSheet, drain: lastDrain ? { rain: lastDrain.rain, phase: lastDrain.rainPhase } : null, flow: flowOn,
                strandMm: strandMm * (kit.uniforms.u_halfW.value / halfW0),
                model: LAW.id ?? null, dilution: DILUTION, strandExpansion: STRAND_EXPANSION,
            };
        },
    };
}
