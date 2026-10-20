/**
 * screen-line.js — orbit rings drawn at a constant SCREEN width
 * ═══════════════════════════════════════════════════════════════════════════
 * solar-system.html drew each planet's orbit as a `RingGeometry` 0.024 scene
 * units wide. A WORLD width is magnified by perspective: at the top view it is
 * well under a pixel, but locked on Mars the camera sits a fraction of a unit
 * from the ring and the orbit became a ~20 px red bar cutting behind the
 * planet (measured from the 2026-10-11 viewpoint captures). The same lesson as
 * the NEO sizes (NEO_LAYER_PLAN.md §5): anything drawn bigger than true must
 * be bigger in PIXELS, never in world units.
 *
 * This is a ribbon whose two edges are pushed apart in CLIP space, along the
 * screen-space normal of the curve, by `widthPx` CSS pixels — the standard
 * thick-line construction. It is a `MeshBasicMaterial` with only the vertex
 * projection replaced (`onBeforeCompile`), so the fragment side keeps three's
 * own tone-mapping and colour-space chunks: it is NOT a raw `gl_FragColor`
 * shader and does not join the page's hand-held colour pipeline
 * (tests/solar-system-tone.spec.js counts those).
 *
 * The viewport the offset needs is read from the renderer in `onBeforeRender`,
 * so a resize can never leave a ring mis-sized.
 */
import * as THREE from 'three';

const _size = new THREE.Vector2();

/**
 * A closed circle of `radius` in the XZ plane (y = 0, the ecliptic of the
 * orrery's scene), drawn `widthPx` CSS pixels wide whatever the zoom.
 * `radius` may also be a FUNCTION of the azimuth a (x = r·cos a, z = r·sin a)
 * for a closed polar curve — the orrery's eccentric orbits
 * (js/orrery-planets.js `orbitRadiusAtLon`). The tangent is then the curve's
 * own derivative, so the ribbon keeps its pixel width round an ellipse.
 */
export function makeScreenRing(radius, { segments = 256, color = 0xffffff, opacity = 0.2, widthPx = 1.5 } = {}) {
    const n = segments + 1;   // duplicate the seam vertex so the strip closes
    const rAt = typeof radius === 'function' ? radius : () => radius;
    const pos = new Float32Array(n * 2 * 3), tan = new Float32Array(n * 2 * 3), side = new Float32Array(n * 2);
    let rMax = 0;
    for (let i = 0; i < n; i++) {
        const a = (i / segments) * Math.PI * 2;
        const r = rAt(a);
        rMax = Math.max(rMax, r);
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        // d/da of (r cos a, r sin a); for a constant r this is r·(−sin a, cos a),
        // normalised below to exactly the circle's old tangent.
        const h = 1e-4, dr = (rAt(a + h) - rAt(a - h)) / (2 * h);
        let tx = dr * Math.cos(a) - r * Math.sin(a), tz = dr * Math.sin(a) + r * Math.cos(a);
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl; tz /= tl;
        for (let s = 0; s < 2; s++) {
            const k = i * 2 + s;
            pos[k * 3] = x; pos[k * 3 + 1] = 0; pos[k * 3 + 2] = z;
            tan[k * 3] = tx; tan[k * 3 + 1] = 0; tan[k * 3 + 2] = tz;
            side[k] = s === 0 ? -1 : 1;
        }
    }
    const index = [];
    for (let i = 0; i < segments; i++) {
        const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
        index.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aTangent', new THREE.BufferAttribute(tan, 3));
    g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    g.setIndex(index);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), rMax * 1.01);

    const uniforms = {
        u_viewport: { value: new THREE.Vector2(1280, 720) },   // drawing buffer, device px
        u_halfPx:   { value: widthPx * 0.5 },
        u_dpr:      { value: 1 },
        u_tanStep:  { value: rMax * 0.01 },
    };
    const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });
    m.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `#include <common>
    attribute vec3 aTangent;
    attribute float aSide;
    uniform vec2 u_viewport;
    uniform float u_halfPx;
    uniform float u_dpr;
    uniform float u_tanStep;`)
            .replace('#include <project_vertex>', `
    vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
    vec4 clipA = projectionMatrix * mvPosition;
    vec4 clipB = projectionMatrix * (modelViewMatrix * vec4(transformed + aTangent * u_tanStep, 1.0));
    // Screen-space direction of the curve (w clamped: a vertex behind the
    // camera is clipped anyway, but must not divide by ~0 on the way).
    vec2 sA = clipA.xy / max(abs(clipA.w), 1e-5) * u_viewport;
    vec2 sB = clipB.xy / max(abs(clipB.w), 1e-5) * u_viewport;
    vec2 dir = sB - sA;
    dir = length(dir) > 1e-6 ? normalize(dir) : vec2(1.0, 0.0);
    vec2 nrm = vec2(-dir.y, dir.x);
    // halfPx CSS → device px → NDC (2 NDC units span the viewport), times w.
    clipA.xy += nrm * aSide * (u_halfPx * u_dpr * 2.0 / u_viewport) * clipA.w;
    gl_Position = clipA;`);
    };
    m.customProgramCacheKey = () => 'screen-ring-v1';
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    mesh.userData.screenWidthPx = widthPx;
    mesh.userData.screenUniforms = uniforms;
    mesh.onBeforeRender = (renderer) => {
        renderer.getDrawingBufferSize(_size);
        uniforms.u_viewport.value.copy(_size);
        uniforms.u_dpr.value = renderer.getPixelRatio();
    };
    return mesh;
}
