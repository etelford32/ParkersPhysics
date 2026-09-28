/**
 * upper-atmosphere-point-cap.js — no point sprite may fill the screen
 * ═══════════════════════════════════════════════════════════════════════════
 * Every `THREE.Points` layer on upper-atmosphere.html is sized in WORLD
 * units with `sizeAttenuation`, which is right from the default ~2 R⊕ view
 * (sub-pixel to a few pixels) and wrong from a layer transit or a chase
 * camera, where the same sprite sits a few km away. Measured at the 95 km
 * floor: the layer particles drew as 30 px SQUARES (no texture — an
 * untextured point is an uncapped square, the Boötes scar) and the transit
 * gas as 71 px blobs that stacked into white snowballs under additive
 * blending.
 *
 * `capPointSize` clamps `gl_PointSize` to a fixed CSS-pixel ceiling (times
 * the renderer's pixel ratio, since three multiplies `size` by it) and, for
 * vertex-coloured additive layers, dims a clamped sprite by the area it
 * lost so a dot passing the lens reads as a faint streak, not a flash.
 * Below the ceiling nothing changes, so the orbit view is untouched.
 *
 * `roundDotTexture` is the disc the untextured layers lacked: solid to
 * 55 % of the radius so a small dot keeps its brightness, soft to the rim.
 */

import * as THREE from 'three';

/**
 * @param {THREE.PointsMaterial} material
 * @param {object} [o]
 * @param {number} [o.maxPx=10]        ceiling in CSS pixels
 * @param {boolean} [o.fadeNear=true]  dim clamped vertex-coloured sprites
 * @returns {THREE.PointsMaterial} the same material
 */
export function capPointSize(material, { maxPx = 10, fadeNear = true } = {}) {
    const prev = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
        if (typeof prev === 'function') prev.call(material, shader, renderer);
        const dpr = renderer?.getPixelRatio?.() ?? 1;
        shader.uniforms.uPtCapPx = { value: maxPx * dpr };
        const fade = fadeNear
            ? '#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )\n'
              + '    vColor *= clamp( ptCap / max( ptRaw, 1e-3 ), 0.2, 1.0 );\n'
              + '#endif\n'
            : '';
        shader.vertexShader = shader.vertexShader
            .replace('void main() {', 'uniform float uPtCapPx;\nvoid main() {')
            .replace('#include <fog_vertex>',
                '#include <fog_vertex>\n'
                + '    float ptCap = uPtCapPx;\n'
                + '    float ptRaw = gl_PointSize;\n'
                + '    gl_PointSize = min( ptRaw, ptCap );\n'
                + fade);
    };
    const key = `ptcap:${maxPx}:${fadeNear ? 1 : 0}`;
    const prevKey = material.customProgramCacheKey?.bind(material);
    material.customProgramCacheKey = () => `${prevKey ? prevKey() : ''}|${key}`;
    material.userData.pointCapPx = maxPx;
    material.needsUpdate = true;
    return material;
}

let _dot = null;
/** Shared soft-edged disc for point sprites (one texture for every layer). */
export function roundDotTexture() {
    if (_dot) return _dot;
    const size = 64;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.55, 'rgba(255,255,255,1)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
    _dot = new THREE.CanvasTexture(c);
    _dot.needsUpdate = true;
    return _dot;
}
