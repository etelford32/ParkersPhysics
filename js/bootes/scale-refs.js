/**
 * bootes/scale-refs.js — the ruler the 3D stage was missing
 * ═══════════════════════════════════════════════════════════════════════════
 * Rendering only; every distance comes in already computed. Builds the three
 * things that turn the render from a pretty starburst into something you can
 * measure against:
 *
 *   1. RANGE RINGS on the graticule plane, at fixed multiples of R_eff, with
 *      the multiple AND the physical distance on each label. A void render
 *      without these has no scale at all — the reader cannot tell 90 Mpc from
 *      900, and the whole argument of the page is about a specific radius.
 *   2. LABELS on the things that are real: the nine catalogued clusters, and
 *      the direction back to the Milky Way. Everything else in the scene is
 *      model, so the only labelled objects should be the measured ones.
 *   3. THE SIGHTLINE GNOMON, drawn along the actual oblique direction to the
 *      observer rather than along a coordinate axis.
 *
 * WHY FIXED RINGS AND NOT ADAPTIVE ONES. The rings are the reader's ruler, and
 * a ruler whose tick spacing changes as you zoom is not a ruler. "The filament
 * sits two rings out" has to mean the same thing before and after a zoom, so
 * `RANGE_RINGS` in bootes/camera-math.js is a constant and the DOM scale bar —
 * which IS adaptive — carries the zoom-dependent half of the job.
 *
 * LABELS ARE SCREEN-SIZED, NOT WORLD-SIZED (`sizeAttenuation: false`). A
 * world-sized label is legible at exactly one camera distance: it becomes a
 * smear when you push in and a dot when you pull out. Annotation is chrome, it
 * lives in screen space, and the only cost is that a label does not tell you
 * how far away its object is — which is what the rings are for.
 */

import * as THREE from 'three';
import { RANGE_RINGS } from './camera-math.js';

/** Colours, kept in step with bootes/charts.js PALETTE. */
const INK = '#cdd5e4';
const DIM = '#8b94ad';
const VOID_BLUE = '#4fc3f7';
const WALL_ORANGE = '#ff9a56';
const LOS_VIOLET = '#c792ea';

/**
 * Build a screen-sized text label as a sprite.
 *
 * Rendered to a 2× canvas and tagged `SRGBColorSpace` so the text comes back
 * the colour it was written in — an untagged canvas texture is treated as
 * linear and the label washes out to a pale smudge against a dark scene, which
 * reads as a rendering fault rather than as a colour-space slip.
 */
export function makeLabel(text, {
    color = INK, background = 'rgba(3,1,14,.62)', heightFrac = 0.022,
    padX = 10, padY = 5, fontPx = 26, border = null,
} = {}) {
    const dpr = 2;
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = `600 ${fontPx}px system-ui, sans-serif`;
    const textW = Math.ceil(measure.measureText(text).width);
    const w = textW + padX * 2;
    const h = fontPx + padY * 2;

    const canvas = document.createElement('canvas');
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    if (background) {
        ctx.fillStyle = background;
        ctx.beginPath();
        ctx.roundRect(0, 0, w, h, 6);
        ctx.fill();
    }
    if (border) {
        ctx.strokeStyle = border;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(0.5, 0.5, w - 1, h - 1, 6);
        ctx.stroke();
    }
    ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(text, w / 2, h / 2 + 1);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;

    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: texture, transparent: true, depthTest: false, depthWrite: false,
        sizeAttenuation: false,
    }));
    // depthTest:false so a label is never swallowed by the tracer cloud it
    // annotates. These are chrome; they sit on top by design.
    sprite.renderOrder = 900;
    sprite.scale.set(heightFrac * (w / h), heightFrac, 1);
    sprite.userData.dispose = () => { texture.dispose(); sprite.material.dispose(); };
    return sprite;
}

/** A flat circle of `segments` points on the y = 0 plane, as a line loop. */
function ringGeometry(radius, segments = 128) {
    const pts = new Float32Array((segments + 1) * 3);
    for (let i = 0; i <= segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        pts[i * 3] = Math.cos(a) * radius;
        pts[i * 3 + 1] = 0;
        pts[i * 3 + 2] = Math.sin(a) * radius;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    return geo;
}

/**
 * Build the whole scale reference into `group`, clearing whatever was there.
 *
 * `toScene` converts comoving Mpc to scene units — passed in rather than
 * imported so this module never has an opinion about the scene's scale, which
 * is owned in exactly one place (SCENE_SCALE in bootes/scene.js).
 */
export function buildScaleRefs(group, {
    rEffMpc, toScene, losUnit, anchors = [], showLabels = true,
}) {
    while (group.children.length) {
        const child = group.children.pop();
        child.userData?.dispose?.();
        child.geometry?.dispose?.();
        child.material?.dispose?.();
    }

    const labels = [];
    const addLabel = (sprite, x, y, z) => {
        sprite.position.set(x, y, z);
        sprite.visible = showLabels;
        group.add(sprite);
        labels.push(sprite);
    };

    // ── Range rings ─────────────────────────────────────────────────────────
    for (const mult of RANGE_RINGS) {
        const rMpc = rEffMpc * mult;
        // 1 R_eff is the one that carries the argument, so it is drawn
        // brighter than its neighbours. The rest are a grid.
        const primary = mult === 1;
        const geo = ringGeometry(toScene(rMpc));
        const mat = new THREE.LineBasicMaterial({
            color: primary ? 0x4fc3f7 : 0x5a6ea0,
            transparent: true,
            opacity: primary ? 0.62 : 0.3,
        });
        group.add(new THREE.Line(geo, mat));

        if (mult === 0.5 || mult === 1.5) continue;   // drawn, not labelled

        // STAGGERED AROUND THE CIRCLE, not all at +x. Stacked at one azimuth
        // the three ring labels line up on a single screen row and read as one
        // run-on caption — worst from the top-down view, which is the view they
        // matter most in. Spreading them by 34° apiece keeps each one beside
        // its own ring.
        const angle = (RANGE_RINGS.indexOf(mult)) * 0.6;
        const s = toScene(rMpc);
        addLabel(makeLabel(
            `${mult} R_eff · ${Math.round(rMpc)} Mpc`,
            { color: primary ? VOID_BLUE : DIM, heightFrac: primary ? 0.024 : 0.020,
              border: primary ? 'rgba(79,195,247,.35)' : null }),
            Math.cos(angle) * s, 0, Math.sin(angle) * s);
    }

    // Radial spokes, so the rings read as a plane rather than as floating
    // hoops. Eight is enough to give the plane an orientation and few enough
    // that they do not compete with the filaments.
    {
        const inner = toScene(rEffMpc * 0.5);
        const outer = toScene(rEffMpc * 3);
        const verts = new Float32Array(8 * 2 * 3);
        for (let i = 0; i < 8; i++) {
            const a = (i / 8) * Math.PI * 2;
            verts[i * 6] = Math.cos(a) * inner;
            verts[i * 6 + 1] = 0;
            verts[i * 6 + 2] = Math.sin(a) * inner;
            verts[i * 6 + 3] = Math.cos(a) * outer;
            verts[i * 6 + 4] = 0;
            verts[i * 6 + 5] = Math.sin(a) * outer;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
        group.add(new THREE.Line(geo, new THREE.LineBasicMaterial({
            color: 0x5a6ea0, transparent: true, opacity: 0.11,
        })));
    }

    // ── The meridian at R_eff ───────────────────────────────────────────────
    // One vertical great circle. Without it the range rings are coplanar and a
    // top-down view is the only one in which they convey anything.
    {
        const geo = ringGeometry(toScene(rEffMpc));
        const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
            color: 0x4fc3f7, transparent: true, opacity: 0.22,
        }));
        line.rotation.x = Math.PI / 2;
        group.add(line);
    }

    // ── The sightline gnomon ────────────────────────────────────────────────
    // Drawn along the ACTUAL oblique direction to the Milky Way. See the
    // header of bootes/camera-math.js for why this must never be an axis.
    {
        const len = toScene(rEffMpc * 2.1);
        const d = losUnit;
        const verts = new Float32Array([0, 0, 0, d[0] * len, d[1] * len, d[2] * len]);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
        group.add(new THREE.Line(geo, new THREE.LineBasicMaterial({
            color: 0xc792ea, transparent: true, opacity: 0.55,
        })));
        addLabel(makeLabel('→ Milky Way · 226 Mpc',
            { color: LOS_VIOLET, heightFrac: 0.022, border: 'rgba(199,146,234,.3)' }),
            d[0] * len, d[1] * len, d[2] * len);
    }

    // ── Cluster labels: the only measured objects in the scene ──────────────
    // Nudged 4 % further out along their own radius so the text sits BESIDE the
    // dot rather than on top of it — a label centred on its marker hides the
    // one pixel that says where the object actually is.
    for (const a of anchors) {
        const s = toScene(1.04);
        addLabel(makeLabel(a.shortName || a.name,
            { color: INK, heightFrac: 0.019, background: 'rgba(3,1,14,.66)',
              border: 'rgba(205,213,228,.2)' }),
            a.offsetMpc[0] * s, a.offsetMpc[1] * s, a.offsetMpc[2] * s);
    }

    return {
        labels,
        setLabelsVisible(on) { for (const l of labels) l.visible = on; },
    };
}
