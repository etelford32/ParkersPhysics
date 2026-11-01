/**
 * launch-surface-detail.js — Procedural surface detail for the launch
 * planner's vehicles, injected into their existing PBR materials.
 *
 * WHY OBJECT SPACE AND NOT A TEXTURE: the hulls are LatheGeometry, whose v
 * coordinate is the profile POINT INDEX, not arc length — Super Heavy's
 * whole 60 m barrel is one profile segment between two points, so any map
 * laid on its UVs would stretch one texel row over most of the booster.
 * The detail is therefore computed per fragment from the mesh's OBJECT-space
 * position (height along the stack axis, azimuth around it), which is the
 * same everywhere regardless of how a profile was sampled.
 *
 * Kinds:
 *   'steel' — stainless rings: a weld line every `ringPitch` metres (Starship
 *             is built from ~1.83 m rings), 8 panels per ring with their own
 *             tint/roughness, thin vertical seams, faint streaking.
 *   'tiles' — hexagonal heat-shield tiles in (arc length, height), with
 *             light grout, per-tile tint (replacement tiles read lighter).
 *   'foam'  — the External Tank's sprayed-on foam: two-scale mottling and
 *             vertical runs, with matching roughness variation.
 *
 * Everything is a MULTIPLIER on the material's own colour/roughness, so the
 * vehicle keeps its palette and the no-detail path (WebGL1, or
 * setSurfaceDetailEnabled(false)) is the old look exactly.
 *
 * Lines are antialiased with fwidth() so a weld 6 cm wide does not shimmer
 * when the stack is 300 m away; that needs derivatives, which WebGL2 always
 * has — hence the WebGL2 gate.
 *
 * Public API:
 *   addSurfaceDetail(material, { kind, ringPitch, panels, tileSize, strength })
 *   setSurfaceDetailEnabled(bool)
 */

let _enabled = true;
export function setSurfaceDetailEnabled(on) { _enabled = !!on; }

const COMMON = /* glsl */`
    varying vec3 vObjPos;
    float sd_h12(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
    }
    float sd_n2(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(sd_h12(i), sd_h12(i + vec2(1, 0)), f.x),
                   mix(sd_h12(i + vec2(0, 1)), sd_h12(i + vec2(1, 1)), f.x), f.y);
    }
    // 0 on a line at integer x, 1 away from it; width w in units of x, AA'd.
    float sd_line(float x, float w) {
        float d = abs(fract(x + 0.5) - 0.5);
        float aa = fwidth(x) * 1.2;
        return smoothstep(w, w + aa, d);
    }
`;

const KIND_GLSL = {
    steel: /* glsl */`
        void sd_apply(inout vec3 col, inout float rough) {
            float ang = atan(vObjPos.z, vObjPos.x) / 6.28318530718 + 0.5;
            float yr  = vObjPos.y / SD_RING;
            float ring = floor(yr);
            float panel = floor(ang * SD_PANELS);
            float h = sd_h12(vec2(ring, panel));
            float tint = 0.94 + 0.10 * h;
            float weld = sd_line(yr, 0.018);                   // ~3 cm each side
            float seam = sd_line(ang * SD_PANELS, 0.010);
            float streak = sd_n2(vec2(ang * 90.0, vObjPos.y * 0.15));
            col *= tint * mix(0.78, 1.0, weld) * mix(0.88, 1.0, seam) * (0.96 + 0.06 * streak);
            rough = clamp(rough + (h - 0.5) * 0.10 * SD_STRENGTH + (1.0 - weld) * 0.22, 0.04, 1.0);
        }
    `,
    tiles: /* glsl */`
        void sd_apply(inout vec3 col, inout float rough) {
            float R = max(length(vObjPos.xz), 0.1);
            float s = atan(vObjPos.z, vObjPos.x) * R;            // arc length, m
            vec2 p = vec2(s, vObjPos.y) / SD_TILE;
            // Hex grid: two offset rectangular lattices, nearest centre wins.
            vec2 r = vec2(1.0, 1.7320508);
            vec2 hr = r * 0.5;
            vec2 a = mod(p, r) - hr;
            vec2 b = mod(p - hr, r) - hr;
            vec2 g = dot(a, a) < dot(b, b) ? a : b;
            vec2 id = p - g;
            // Distance to the hex edge (0 at centre … 0.5 at the edge).
            vec2 q = abs(g);
            float e = max(dot(q, vec2(0.5, 0.8660254)), q.x);
            float aa = fwidth(e) * 1.5;
            float grout = smoothstep(0.47, 0.47 - aa - 0.01, e);   // 1 inside the tile
            float h = sd_h12(floor(id * 2.0 + 0.5));
            float tint = 0.85 + 0.25 * h + (h > 0.965 ? 0.55 : 0.0);  // a few replacement tiles
            col *= mix(1.9, tint, grout);
            rough = clamp(rough + (1.0 - grout) * 0.15 - h * 0.06, 0.04, 1.0);
        }
    `,
    foam: /* glsl */`
        void sd_apply(inout vec3 col, inout float rough) {
            float ang = atan(vObjPos.z, vObjPos.x);
            float R = max(length(vObjPos.xz), 0.1);
            vec2 p = vec2(ang * R, vObjPos.y);
            float m1 = sd_n2(p * 0.9);
            float m2 = sd_n2(p * 3.7 + 7.0);
            float runs = sd_n2(vec2(ang * R * 2.2, vObjPos.y * 0.12));
            float v = 0.55 * m1 + 0.30 * m2 + 0.15 * runs;
            col *= mix(0.80, 1.12, v * SD_STRENGTH + (1.0 - SD_STRENGTH) * 0.6);
            rough = clamp(rough - (v - 0.5) * 0.12, 0.04, 1.0);
        }
    `,
};

export function addSurfaceDetail(material, opts = {}) {
    if (!_enabled || !material || !KIND_GLSL[opts.kind]) return material;
    const kind = opts.kind;
    const ring = (opts.ringPitch ?? 1.83).toFixed(4);
    const panels = (opts.panels ?? 8).toFixed(1);
    const tile = (opts.tileSize ?? 0.95).toFixed(4);
    const strength = (opts.strength ?? 1).toFixed(3);
    const defs = `#define SD_RING ${ring}\n#define SD_PANELS ${panels}\n#define SD_TILE ${tile}\n#define SD_STRENGTH ${strength}\n`;
    const prev = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
        if (prev) prev(shader, renderer);
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vObjPos;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjPos = position;');
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>\n${defs}${COMMON}${KIND_GLSL[kind]}`)
            .replace('#include <roughnessmap_fragment>',
                     '#include <roughnessmap_fragment>\nsd_apply(diffuseColor.rgb, roughnessFactor);');
    };
    const key = `sd:${kind}:${ring}:${panels}:${tile}:${strength}`;
    const prevKey = material.customProgramCacheKey?.bind(material);
    material.customProgramCacheKey = () => (prevKey ? prevKey() : '') + key;
    material.needsUpdate = true;
    return material;
}
