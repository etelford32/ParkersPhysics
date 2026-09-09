/**
 * bootes/scene.js — the 3D stage on bootes-void.html
 * ═══════════════════════════════════════════════════════════════════════════
 * Rendering only. Every number this file draws arrives already computed from
 * js/bootes-void-model.js and js/bootes-web-model.js; there is no physics here
 * and there must never be, or the picture and the figures beside it could
 * disagree about the same quantity.
 *
 * THE FRAME. Void-centred, comoving Mpc, right-handed EQUATORIAL — the same
 * frame js/bootes-void-data.js resolves anchors into, so a cluster direction
 * needs no conversion to be drawn. `SCENE_SCALE` is the only place Mpc becomes
 * scene units, and it exists purely so the near/far planes and the camera
 * distances are ordinary numbers.
 *
 * THE LINE OF SIGHT IS NOT AN AXIS. `losUnitFromVoid()` is an oblique
 * direction in this frame, and the redshift-space displacement is applied
 * along it. Snapping it to +Z would produce a figure that looks entirely
 * correct and distorts the void along the wrong direction — which is worse
 * than not drawing it, because it cannot be spotted by eye.
 *
 * WHAT THE VECTOR FIELD DRAWS, AND WHY IT IS A LINE AND NOT A CONE
 * ───────────────────────────────────────────────────────────────
 * Arrows are LineSegments with a two-stroke head, not instanced cone meshes.
 * At 700 arrows the cones measured ~4× the frame cost for a shape nobody can
 * resolve at this density, and — more importantly — a lit mesh encodes
 * magnitude in its SIZE, which competes with the length that already encodes
 * it. Lines encode magnitude in length and colour and nothing else.
 *
 * ARROW LENGTH IS NORMALISED PER MODE, AND THE PAGE SAYS SO. The four fields
 * differ in magnitude by more than an order of magnitude — Δg outside the wall
 * is a fraction of g_A inside it — so a single absolute scale would render
 * three of the four modes as invisible stubs. Each mode is scaled to its own
 * maximum and the legend prints that maximum, so the picture stays comparable
 * in DIRECTION across modes and the numbers stay honest about magnitude.
 */

import * as THREE from 'three';
import { createCameraRig } from './camera.js';
import { buildScaleRefs } from './scale-refs.js';

/** Mpc per scene unit. Only conversion in the file. */
export const SCENE_SCALE = 20;

const mpc = (v) => v / SCENE_SCALE;

/**
 * A soft round dot, generated once and shared by every Points material.
 *
 * WITHOUT IT, POINTS ARE SQUARES. `PointsMaterial` draws an untextured point as
 * a hard axis-aligned quad, and with `sizeAttenuation` on there is no upper
 * bound on how large that quad gets — so the "inside the void" viewpoint, where
 * the camera sits 20 Mpc from tracers that are metres away in scene units,
 * rendered the galaxy field as a scatter of fat white rectangles. A radial
 * alpha falloff makes the same geometry read as a soft glow at every distance,
 * which is both what a galaxy should look like and the cheapest possible fix
 * (one 64×64 texture, no shader).
 */
let dotTexture = null;
function softDot() {
    if (dotTexture) return dotTexture;
    const size = 64;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,.85)');
    g.addColorStop(0.7, 'rgba(255,255,255,.22)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    dotTexture = new THREE.CanvasTexture(c);
    dotTexture.colorSpace = THREE.SRGBColorSpace;
    return dotTexture;
}

/**
 * Fade a line material out as it approaches the camera.
 *
 * NOT A MAGNITUDE CHANGE, AND THAT DISTINCTION IS THE WHOLE POINT. Arrow LENGTH
 * encodes field strength and must never respond to the camera. What responds is
 * ALPHA: an arrow whose tail is two Mpc from the eye is drawn as a streak across
 * the entire frame, edge-on and unreadable, and it hides the structure behind
 * it. That is the "inside the void" viewpoint's whole failure mode — the camera
 * sits at 0.22 R_eff and the innermost sample shell is right against the lens.
 *
 * Fading them is the same move a volume renderer makes at its near plane, and
 * it is honest in a way that shortening them would not be: every arrow still
 * has exactly the length its magnitude earned, and the ones you cannot read are
 * simply not drawn on top of the ones you can.
 *
 * Implemented with onBeforeCompile rather than a custom ShaderMaterial so the
 * material keeps three's own colour management and fog handling — a hand-rolled
 * replacement is how the vertex colours stop matching the charts.
 */
function applyNearFade(material, near0, near1) {
    material.onBeforeCompile = (shader) => {
        shader.uniforms.uNearFade = { value: new THREE.Vector2(near0, near1) };
        shader.vertexShader = shader.vertexShader
            .replace('void main() {', 'varying float vCamDist;\nvoid main() {')
            .replace('#include <fog_vertex>',
                '#include <fog_vertex>\n\tvCamDist = -mvPosition.z;');
        shader.fragmentShader = shader.fragmentShader
            .replace('void main() {',
                'uniform vec2 uNearFade;\nvarying float vCamDist;\nvoid main() {')
            // AFTER <opaque_fragment>, not before. That chunk ends with
            //     gl_FragColor = vec4( outgoingLight, diffuseColor.a );
            // so anything written to gl_FragColor ahead of it is discarded.
            // The first version of this prepended the multiply, compiled
            // cleanly, produced no warning and had exactly zero effect — the
            // arrows were identical with the fade set to 7 Mpc and to 9999.
            .replace('#include <opaque_fragment>',
                '#include <opaque_fragment>\n'
                + '\tgl_FragColor.a *= smoothstep(uNearFade.x, uNearFade.y, vCamDist);');
    };
    // Materials that share a program are cached by their compile key; bumping
    // this makes three rebuild rather than reuse an unfaded program.
    material.customProgramCacheKey = () => `nearfade-${near0}-${near1}`;
    return material;
}

/** Blue → white → orange, matching the charts' void/wall pair. */
function rampColor(t, out = new THREE.Color()) {
    const x = Math.max(0, Math.min(1, t));
    if (x < 0.5) {
        const u = x / 0.5;
        return out.setRGB(0.16 + 0.68 * u, 0.55 + 0.4 * u, 0.92 + 0.06 * u);
    }
    const u = (x - 0.5) / 0.5;
    return out.setRGB(0.84 + 0.16 * u, 0.95 - 0.35 * u, 0.98 - 0.64 * u);
}

/**
 * Build the stage. Returns null if WebGL is unavailable — the caller falls
 * back to the figures alone, which carry every number the render illustrates.
 * A page that hard-fails on no-WebGL loses the science along with the picture.
 */
export function createBootesScene(canvas, {
    rEffMpc = 91.6,
    losUnit = [0, 0, 1],
    onPose = null,
    onViewpoint = null,
    onFocus = null,
} = {}) {
    let renderer;
    try {
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch (err) {
        return null;
    }
    if (!renderer.getContext()) return null;

    renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
    renderer.setClearColor(0x03010e, 0);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 600);

    // The camera rig owns OrbitControls, the viewpoints, the keyboard and
    // click-to-focus. Read its header before touching camera.up.
    const rig = createCameraRig({
        canvas, camera, toScene: mpc, fromScene: (u) => u * SCENE_SCALE,
        rEffMpc, losUnit, onPose, onViewpoint, onFocus,
    });
    const controls = rig.controls;

    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const key = new THREE.DirectionalLight(0xffffff, 0.5);
    key.position.set(1, 1, 1);
    scene.add(key);

    // ── Groups, so a rebuild can replace one layer without touching others ──
    const groups = {
        tracers: new THREE.Group(),
        web: new THREE.Group(),
        shell: new THREE.Group(),
        field: new THREE.Group(),
        markers: new THREE.Group(),
        refs: new THREE.Group(),
    };
    Object.values(groups).forEach(g => scene.add(g));

    const disposables = [];
    const track = (obj) => { disposables.push(obj); return obj; };
    function clear(group) {
        while (group.children.length) {
            const child = group.children.pop();
            child.geometry?.dispose?.();
            child.material?.dispose?.();
        }
    }

    // ── The void shell + its wall, drawn once ───────────────────────────────
    let shellWire = null;
    let shellRadiusScene = 0;

    function buildShell(rEffMpc, rsMpc) {
        clear(groups.shell);
        shellRadiusScene = mpc(rEffMpc);
        // R_eff: a faint wireframe sphere. Deliberately NOT a solid surface —
        // the void has no boundary, it has a profile, and a hard surface is
        // the single most common way these renders lie about what a void is.
        //
        // 32×16 segments, not 48×32: from anywhere near the shell the far half
        // of the mesh fills the frame, and a dense wireframe stops reading as
        // "a sphere at this radius" and starts reading as "a lattice", which is
        // a structure the model does not have.
        shellWire = new THREE.Mesh(
            new THREE.SphereGeometry(shellRadiusScene, 32, 16),
            new THREE.MeshBasicMaterial({
                color: 0x4fc3f7, wireframe: true, transparent: true, opacity: 0.07,
            }));
        groups.shell.add(shellWire);
        // The zero crossing r_s, where δ changes sign: the honest "edge".
        const cross = new THREE.Mesh(
            new THREE.SphereGeometry(mpc(rsMpc), 64, 40),
            new THREE.MeshBasicMaterial({
                color: 0x4fc3f7, transparent: true, opacity: 0.045,
                side: THREE.BackSide, depthWrite: false,
            }));
        groups.shell.add(cross);
    }

    // ── Tracer galaxies ─────────────────────────────────────────────────────
    function buildTracers(tracers, { redshiftSpace = null } = {}) {
        clear(groups.tracers);
        if (!tracers?.length) return;
        const positions = new Float32Array(tracers.length * 3);
        const colors = new Float32Array(tracers.length * 3);
        const c = new THREE.Color();
        tracers.forEach((t, i) => {
            const p = redshiftSpace ? redshiftSpace(t) : t.offsetMpc;
            positions[i * 3] = mpc(p[0]);
            positions[i * 3 + 1] = mpc(p[1]);
            positions[i * 3 + 2] = mpc(p[2]);
            // Colour by local galaxy contrast: void interior cool, wall warm.
            rampColor((t.deltaG + 1) / 1.6, c);
            colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
        });
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        const mat = new THREE.PointsMaterial({
            size: 0.085, vertexColors: true, transparent: true, opacity: 0.9,
            sizeAttenuation: true, depthWrite: false, map: softDot(),
            alphaTest: 0.02, blending: THREE.AdditiveBlending,
        });
        groups.tracers.add(track(new THREE.Points(geo, mat)));
    }

    // ── The web: filaments as lines, nodes as points sized by mass ──────────
    function buildWeb(web) {
        clear(groups.web);
        if (!web) return;
        const segs = new Float32Array(web.filaments.length * 6);
        web.filaments.forEach((f, i) => {
            const a = web.nodes[f.a].offsetMpc;
            const b = web.nodes[f.b].offsetMpc;
            segs[i * 6] = mpc(a[0]); segs[i * 6 + 1] = mpc(a[1]); segs[i * 6 + 2] = mpc(a[2]);
            segs[i * 6 + 3] = mpc(b[0]); segs[i * 6 + 4] = mpc(b[1]); segs[i * 6 + 5] = mpc(b[2]);
        });
        const lg = new THREE.BufferGeometry();
        lg.setAttribute('position', new THREE.BufferAttribute(segs, 3));
        groups.web.add(track(new THREE.LineSegments(lg, applyNearFade(
            new THREE.LineBasicMaterial({
                color: 0xff9a56, transparent: true, opacity: 0.34,
            }), mpc(4), mpc(16)))));

        // Nodes. Point size cannot vary per-vertex in PointsMaterial without a
        // custom shader, so mass is encoded in BRIGHTNESS instead — which is
        // the honest choice anyway, since a bigger dot at this density reads
        // as "closer" more than as "heavier".
        const maxMass = Math.max(...web.nodes.map(n => n.massMsun)) || 1;
        const np = new Float32Array(web.nodes.length * 3);
        const nc = new Float32Array(web.nodes.length * 3);
        web.nodes.forEach((n, i) => {
            np[i * 3] = mpc(n.offsetMpc[0]);
            np[i * 3 + 1] = mpc(n.offsetMpc[1]);
            np[i * 3 + 2] = mpc(n.offsetMpc[2]);
            const b = 0.35 + 0.65 * Math.sqrt(n.massMsun / maxMass);
            nc[i * 3] = b; nc[i * 3 + 1] = b * 0.66; nc[i * 3 + 2] = b * 0.36;
        });
        const ng = new THREE.BufferGeometry();
        ng.setAttribute('position', new THREE.BufferAttribute(np, 3));
        ng.setAttribute('color', new THREE.BufferAttribute(nc, 3));
        groups.web.add(track(new THREE.Points(ng, new THREE.PointsMaterial({
            size: 0.34, vertexColors: true, transparent: true, opacity: 0.95,
            sizeAttenuation: true, map: softDot(), alphaTest: 0.02,
            blending: THREE.AdditiveBlending, depthWrite: false,
        }))));
    }

    // ── Named anchors + the line of sight ───────────────────────────────────
    let refsHandle = null;
    let labelsVisible = true;

    /**
     * The measured objects and the ruler.
     *
     * Both live here because they answer the same question — "how big is this,
     * and what in it is real?" The nine catalogued clusters are the only
     * observed positions in the scene, so they are the only things labelled by
     * name; everything else is model and the page says so.
     */
    function buildMarkers(anchors, losUnitVec, rEff) {
        clear(groups.markers);

        // Cluster dots. The sightline itself is drawn by the scale refs, which
        // owns every distance cue in one place.
        if (anchors?.length) {
            const s = mpc(1);
            const ap = new Float32Array(anchors.length * 3);
            anchors.forEach((a, i) => {
                ap[i * 3] = a.offsetMpc[0] * s;
                ap[i * 3 + 1] = a.offsetMpc[1] * s;
                ap[i * 3 + 2] = a.offsetMpc[2] * s;
            });
            const ag = new THREE.BufferGeometry();
            ag.setAttribute('position', new THREE.BufferAttribute(ap, 3));
            groups.markers.add(track(new THREE.Points(ag, new THREE.PointsMaterial({
                color: 0xffffff, size: 0.5, transparent: true, opacity: 0.95,
                sizeAttenuation: true, map: softDot(), alphaTest: 0.02,
                depthWrite: false,
            }))));
        }

        refsHandle = buildScaleRefs(groups.refs, {
            rEffMpc: rEff, toScene: mpc, losUnit: losUnitVec,
            anchors: anchors ?? [], showLabels: labelsVisible,
        });
        rig.setPickables((anchors ?? []).map(a => ({
            id: a.id, name: a.name, positionMpc: a.offsetMpc, radiusMpc: a.radiusMpc,
        })));
    }

    /**
     * The vector field. `samples` is an array of { position, vector } already
     * in comoving Mpc / SI, and `maxMagnitude` is the normaliser the caller
     * chose — passed in rather than computed here so the legend and the arrows
     * cannot disagree about what "full length" means.
     */
    let lastField = null;
    let arrowMpcInUse = 0;

    /**
     * Arrow length in Mpc, as a function of how far out the camera is.
     *
     * THIS IS A GLYPH ZOOM, NOT A MAGNITUDE CHANGE, and the distinction is the
     * only reason it is allowed. Every arrow in a frame is drawn with the same
     * magnitude→length mapping, so their RELATIVE lengths — the only thing
     * length is claiming — are untouched; what changes is the size of the
     * symbol, exactly as a map's symbols resize with its zoom. The alternative
     * is a single fixed length that is a hairline at 360 Mpc out and a
     * screen-crossing streak from inside the void, which is what shipped first.
     *
     * Clamped at both ends: below ~5 Mpc an arrow has no readable direction,
     * above ~26 Mpc the field turns back into a thicket.
     */
    function arrowLengthFor(cameraDistanceMpc) {
        return Math.max(5, Math.min(26, cameraDistanceMpc * 0.075));
    }

    function buildField(samples, maxMagnitude, { arrowMpc = null } = {}) {
        clear(groups.field);
        if (!samples?.length || !(maxMagnitude > 0)) { lastField = null; return; }
        lastField = { samples, maxMagnitude };
        arrowMpc = arrowMpc ?? arrowLengthFor(camera.position.length() * SCENE_SCALE);
        arrowMpcInUse = arrowMpc;
        // 3 segments per arrow: the shaft plus two head strokes.
        const verts = new Float32Array(samples.length * 3 * 2 * 3);
        const cols = new Float32Array(samples.length * 3 * 2 * 3);
        const c = new THREE.Color();
        const tmp = new THREE.Vector3();
        const dir = new THREE.Vector3();
        const perpA = new THREE.Vector3();
        const perpB = new THREE.Vector3();
        let o = 0;
        const push = (ax, ay, az, bx, by, bz, col) => {
            verts[o] = ax; verts[o + 1] = ay; verts[o + 2] = az;
            cols[o] = col.r; cols[o + 1] = col.g; cols[o + 2] = col.b;
            o += 3;
            verts[o] = bx; verts[o + 1] = by; verts[o + 2] = bz;
            cols[o] = col.r; cols[o + 1] = col.g; cols[o + 2] = col.b;
            o += 3;
        };
        for (const s of samples) {
            const v = s.vector;
            const mag = Math.hypot(v[0], v[1], v[2]);
            const t = Math.min(1, mag / maxMagnitude);
            if (t < 0.008) continue;
            rampColor(t, c);
            dir.set(v[0], v[1], v[2]).normalize();
            const len = mpc(arrowMpc) * (0.25 + 0.75 * Math.sqrt(t));
            const ax = mpc(s.position[0]);
            const ay = mpc(s.position[1]);
            const az = mpc(s.position[2]);
            tmp.copy(dir).multiplyScalar(len);
            const bx = ax + tmp.x;
            const by = ay + tmp.y;
            const bz = az + tmp.z;
            push(ax, ay, az, bx, by, bz, c);
            // Head: two strokes back along the shaft, splayed on an arbitrary
            // perpendicular pair. Orientation of the splay does not matter at
            // this scale and picking one saves a per-arrow basis solve.
            perpA.set(-dir.y, dir.x, 0);
            if (perpA.lengthSq() < 1e-6) perpA.set(0, -dir.z, dir.y);
            perpA.normalize().multiplyScalar(len * 0.18);
            perpB.copy(dir).multiplyScalar(-len * 0.3);
            push(bx, by, bz, bx + perpB.x + perpA.x, by + perpB.y + perpA.y, bz + perpB.z + perpA.z, c);
            push(bx, by, bz, bx + perpB.x - perpA.x, by + perpB.y - perpA.y, bz + perpB.z - perpA.z, c);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(verts.subarray(0, o), 3));
        geo.setAttribute('color', new THREE.BufferAttribute(cols.subarray(0, o), 3));
        groups.field.add(track(new THREE.LineSegments(geo, applyNearFade(
            new THREE.LineBasicMaterial({
                vertexColors: true, transparent: true, opacity: 0.92,
            }), mpc(6), mpc(22)))));
    }

    // ── Render loop ─────────────────────────────────────────────────────────
    let running = true;
    let visible = true;
    let frameCount = 0;
    function resize() {
        const w = canvas.clientWidth || 800;
        const h = canvas.clientHeight || 480;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }
    function frame() {
        if (!running) return;
        requestAnimationFrame(frame);
        rig.update();
        // INSIDE THE SHELL, THE SHELL IS NOISE. Seen from within, the far half
        // of the wireframe covers the whole frame and the reader is looking at
        // a grid instead of at a void. The range rings and the meridian carry
        // the scale from in here, so the sphere simply steps aside — it is the
        // one object whose whole job is to be seen from outside.
        if (shellWire) shellWire.visible = camera.position.length() > shellRadiusScene * 0.99;

        // Re-scale the arrow glyphs when the camera has moved far enough to
        // matter. Throttled to every 12th frame and gated on a 15 % change,
        // because the rebuild walks ~700 samples and doing it on every frame of
        // a flight is a visible hitch for a change nobody can see.
        if (lastField && (frameCount++ % 12) === 0) {
            const want = arrowLengthFor(camera.position.length() * SCENE_SCALE);
            if (Math.abs(want / arrowMpcInUse - 1) > 0.15) {
                buildField(lastField.samples, lastField.maxMagnitude, { arrowMpc: want });
            }
        }
        // Pause only the GL work when off-screen; controls damping still
        // settles so returning to the tab does not snap the camera.
        if (!visible) return;
        renderer.render(scene, camera);
    }
    resize();
    frame();

    const observer = typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver(([e]) => { visible = e.isIntersecting; }, { threshold: 0 })
        : null;
    observer?.observe(canvas);

    return {
        renderer, scene, camera, controls, groups, rig,
        resize,
        buildShell, buildTracers, buildWeb, buildMarkers, buildField,
        setLayerVisible(name, on) {
            if (groups[name]) groups[name].visible = on;
            // The ruler follows the shell toggle: hiding the R_eff shell while
            // leaving its labelled range rings up leaves the labels annotating
            // nothing, which reads as a broken layer rather than a hidden one.
            if (name === 'shell' && groups.refs) groups.refs.visible = on;
        },
        setLabelsVisible(on) {
            labelsVisible = on;
            refsHandle?.setLabelsVisible(on);
            rig.setLabelsFlag(on);
        },
        setAutoRotate(on) { rig.setAutoRotate(on); },
        get autoRotate() { return rig.autoRotate; },
        goTo: (id, opts) => rig.goTo(id, opts),
        resetCamera: (opts) => rig.reset(opts),
        focusOnMpc: (pos, opts) => rig.focusOnMpc(pos, opts),
        currentPose: () => rig.currentPose(),
        get arrowLengthMpc() { return arrowMpcInUse; },
        onLabelToggleRequest: (fn) => rig.onLabelToggleRequest(fn),
        get activeViewpoint() { return rig.activeViewpoint; },
        dispose() {
            running = false;
            observer?.disconnect();
            Object.values(groups).forEach(clear);
            rig.dispose();
            renderer.dispose();
        },
    };
}
