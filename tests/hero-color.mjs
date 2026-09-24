// tests/hero-color.mjs — the pure half of the hero's colour pipeline
// (js/hero-color.js). Run: node tests/hero-color.mjs
//
// What this pins, and why each matters:
//   • the sRGB transfer pair is an exact inverse (every rule depends on it);
//   • heroTone is the IDENTITY below the knee (so no layer's look moves),
//     continuous in value AND slope at the knee (no visible step), monotonic,
//     bounded below display white, and HUE-PRESERVING (the per-channel clip
//     it replaced turned an orange limb yellow — pinned as the contrast case);
//   • rule 2 (`emitLinear`) reproduces a display-authored emitter's pixel
//     EXACTLY on black, and the naive decode(c)·decode(a) does NOT (its toe
//     error is the reason the rule is premultiplied — pinned so nobody
//     "simplifies" it back);
//   • rule 3 for additive built-ins is exact the same way;
//   • the GLSL constants are the JS ones, and the built-in hook lands after
//     `<fog_fragment>` in EVERY built-in fragment shader of the vendored
//     three (a shader without that chunk would be silently unpatched).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    srgbDecode, srgbEncode, TONE, heroTone, outputTransform, emitLinear,
    builtinAdditiveLinear, HERO_COLOR_GLSL, HERO_OUTPUT_FS, adaptMaterialForHdr,
} from '../js/hero-color.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// ── transfer functions ──────────────────────────────────────────────────────
for (let i = 0; i <= 1000; i++) {
    const x = i / 1000;
    near(srgbEncode(srgbDecode(x)), x, 1e-12, `encode∘decode @${x}`);
    near(srgbDecode(srgbEncode(x)), x, 1e-12, `decode∘encode @${x}`);
    if (i) assert.ok(srgbDecode(x) > srgbDecode((i - 1) / 1000), 'decode monotonic');
}
near(srgbDecode(0.5), 0.214041, 1e-6, 'decode(0.5)');
near(srgbEncode(0.18), 0.461356, 1e-6, 'encode(18% grey)');

// ── heroTone ────────────────────────────────────────────────────────────────
const K = TONE.knee;
// Identity (bit-exact) at and below the knee, on every channel mix.
for (const c of [[0, 0, 0], [0.02, 0.01, 0.005], [K, 0.3, 0.1], [0.5, 0.5, 0.5], [0.79, 0.2, 0.7]]) {
    assert.deepEqual(heroTone(c), c, `identity below knee ${c}`);
}
// Value + slope continuous at the knee (grey ramp).
{
    const e = 1e-6;
    near(heroTone([K + e, K + e, K + e])[0], K + e, 1e-9, 'value at knee');
    const slope = (heroTone([K + 2 * e, 0, 0])[0] - heroTone([K + e, 0, 0])[0]) / e;
    near(slope, 1, 1e-3, 'slope at knee');
}
// Monotonic, bounded, → 1 on a grey ramp far into HDR.
{
    let prev = -1;
    for (let x = 0; x <= 200; x += 0.01) {
        const y = heroTone([x, x, x])[0];
        assert.ok(y >= prev - 1e-12, `monotonic @${x}`);
        assert.ok(y < 1, `bounded @${x}`);
        prev = y;
    }
    assert.ok(heroTone([200, 200, 200])[0] > 0.999, 'approaches white');
}
// HUE: HSV hue is preserved exactly (common scale + mix toward neutral keeps
// (max−mid)/(max−min)); saturation falls as the light gets brighter.
const hsv = ([r, g, b]) => {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d > 0) {
        if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
        h *= 60; if (h < 0) h += 360;
    }
    return { h, s: mx > 0 ? d / mx : 0, v: mx };
};
{
    const orange = [1.0, 0.46, 0.18];      // the atmosphere's terminator pick
    let lastS = Infinity;
    for (const gain of [1, 1.5, 2, 4, 8, 32]) {
        const lin = orange.map((v) => v * gain);
        const out = heroTone(lin);
        near(hsv(out).h, hsv(lin).h, 1e-9, `hue kept ×${gain}`);
        assert.ok(hsv(out).s <= lastS + 1e-12, `desaturates as it brightens ×${gain}`);
        lastS = hsv(out).s;
    }
    // The contrast case — the old per-channel hard clip shifts the hue.
    const lin = orange.map((v) => v * 2);
    const clipped = lin.map((v) => Math.min(1, v));
    assert.ok(Math.abs(hsv(clipped).h - hsv(lin).h) > 8, 'the old per-channel clip DID move the hue (orange → yellow)');
}

// ── rule 2: a display-authored emitter alone on black is reproduced exactly ─
{
    let worstNaive = 1;
    for (let i = 0; i <= 40; i++) for (let j = 0; j <= 40; j++) {
        const c = i / 40, a = j / 40;
        const lin = emitLinear([c, c * 0.6, c * 0.2], a);
        const disp = outputTransform(lin);
        const want = [c * a, c * 0.6 * a, c * 0.2 * a];
        // Exact below the knee (0.906 display); within the shoulder beyond it.
        if (Math.max(...lin) <= K) {
            for (let k = 0; k < 3; k++) near(disp[k], want[k], 1e-12, `rule 2 exact c=${c} a=${a} ch${k}`);
        } else {
            // In the shoulder the PEAK channel is compressed (the others are
            // pulled toward it by the desaturation — by design).
            assert.ok(disp[0] <= want[0] + 1e-12, `shoulder never brightens the peak c=${c} a=${a}`);
        }
        // The naive form — decode(c)·decode(a) — drifts in the sRGB toe.
        if (c * a > 0.002) {
            const naive = srgbEncode(srgbDecode(c) * srgbDecode(a));
            worstNaive = Math.min(worstNaive, naive / (c * a));
        }
    }
    assert.ok(worstNaive < 0.5, `the naive decode(c)·decode(a) IS dim in the toe (worst ratio ${worstNaive.toFixed(3)}) — keep rule 2 premultiplied`);
    // Clamped to display white: an 8-bit-tuned emitter never goes HDR on its own.
    assert.deepEqual(emitLinear([3, 1, 0.5], 2), [1, 1, srgbDecode(0.5)], 'rule 2 clamps c and a to [0,1]');
}

// ── rule 3 (additive built-in): exact the same way ──────────────────────────
for (let i = 0; i <= 20; i++) for (let j = 0; j <= 20; j++) {
    const c = i / 20, a = j / 20;
    const lin = builtinAdditiveLinear([srgbDecode(c)], a);
    near(srgbEncode(lin[0]), c * a, 1e-12, `rule 3 exact c=${c} a=${a}`);
}

// ── GLSL mirrors ────────────────────────────────────────────────────────────
{
    const num = (name) => {
        const m = HERO_COLOR_GLSL.match(new RegExp(`const float ${name}\\s*=\\s*([0-9.]+);`));
        assert.ok(m, `${name} declared in HERO_COLOR_GLSL`);
        return Number(m[1]);
    };
    assert.equal(num('HERO_KNEE'), TONE.knee, 'GLSL knee = TONE.knee');
    assert.equal(num('HERO_DESAT'), TONE.desat, 'GLSL desat = TONE.desat');
    // The shoulder expression, as transcribed from heroTone().
    assert.match(HERO_COLOR_GLSL, /float np = 1\.0 - d \* d \/ \(peak \+ d - HERO_KNEE\);/);
    assert.match(HERO_COLOR_GLSL, /float w = 1\.0 - 1\.0 \/ \(HERO_DESAT \* \(peak - np\) \+ 1\.0\);/);
    // Rule 2 is premultiplied and clamped on the HDR path, the identity off it.
    assert.match(HERO_COLOR_GLSL, /return vec4\(heroDecode\(clamp\(c, 0\.0, 1\.0\) \* clamp\(a, 0\.0, 1\.0\)\), 1\.0\);/);
    assert.match(HERO_COLOR_GLSL, /#else\s+return vec4\(c, a\);/);
    // The output pass tone-maps THEN encodes, and dithers.
    assert.match(HERO_OUTPUT_FS, /heroEncode\(heroTone\(/);
    assert.match(HERO_OUTPUT_FS, /uDither \/ 255\.0/);
    // A backtick inside a /* glsl */ template literal terminates it (the
    // orrery scar) — the strings must parse as whole shaders.
    for (const s of [HERO_COLOR_GLSL, HERO_OUTPUT_FS]) assert.ok(!s.includes('`'), 'no backtick in GLSL');
}

// ── rule 3's hook against the vendored three ────────────────────────────────
{
    const ADD = 2;   // THREE.AdditiveBlending in r160
    const src = fs.readFileSync(new URL('../js/vendor/three-0.160.0/three.module.js', import.meta.url), 'utf8');
    assert.match(src, /const AdditiveBlending = 2;/, 'AdditiveBlending is 2 in the vendored three');
    // Every built-in fragment shader that writes gl_FragColor through
    // <opaque_fragment> must also carry <fog_fragment> AFTER it, or the hook
    // (which anchors on it) would leave that material silently unpatched.
    const frags = [...src.matchAll(/const fragment\$?\w* = "((?:[^"\\]|\\.)*)";/g)].map((m) => JSON.parse(`"${m[1]}"`));
    const writers = frags.filter((s) => s.includes('#include <opaque_fragment>'));
    assert.ok(writers.length >= 8, `found the built-in fragment shaders (${writers.length})`);
    for (const s of writers) {
        const o = s.indexOf('#include <opaque_fragment>'), fg = s.indexOf('#include <fog_fragment>');
        assert.ok(fg > o, 'every built-in writer carries <fog_fragment> after <opaque_fragment>');
    }
    const basic = writers.find((s) => s.includes('reflectedLight.indirectDiffuse *= diffuseColor.rgb'));
    assert.ok(basic, 'MeshBasicMaterial fragment found');

    const mk = (props) => ({ userData: {}, ...props });
    const add = mk({ blending: ADD, transparent: true });
    assert.equal(adaptMaterialForHdr(add, ADD), 'additive');
    const sh = { fragmentShader: basic };
    add.onBeforeCompile(sh);
    const at = sh.fragmentShader.indexOf('#include <fog_fragment>');
    assert.ok(sh.fragmentShader.indexOf('heroBDecode(heroBEncode(gl_FragColor.rgb) * clamp(gl_FragColor.a, 0.0, 1.0)), 1.0)') > at, 'additive: premultiplied decode after fog');
    assert.ok(sh.fragmentShader.startsWith('\nfloat heroBDecode1'), 'helpers prepended');
    assert.equal(adaptMaterialForHdr(add, ADD), 'seen', 'idempotent');

    const nrm = mk({ blending: 1, transparent: true });
    assert.equal(adaptMaterialForHdr(nrm, ADD), 'normal');
    const sh2 = { fragmentShader: basic };
    nrm.onBeforeCompile(sh2);
    assert.ok(sh2.fragmentShader.includes('gl_FragColor.a = heroBDecode1('), 'normal: alpha decoded');

    const opq = mk({ blending: 1, transparent: false });
    assert.equal(adaptMaterialForHdr(opq, ADD), 'opaque');
    assert.equal(opq.onBeforeCompile, undefined, 'opaque built-ins are exact already — left alone');
    // Additive wins even when transparent is false (three blends it anyway).
    assert.equal(adaptMaterialForHdr(mk({ blending: ADD, transparent: false }), ADD), 'additive');
    // Raw shaders own their conversion (rules 1/2): the sweep only flips the
    // define — and refuses a shader that would write display values.
    const raw = mk({ isShaderMaterial: true, blending: ADD, defines: { FOO: '1' }, fragmentShader: 'void main(){ gl_FragColor = heroEmit(c, a); }' });
    assert.equal(adaptMaterialForHdr(raw, ADD), 'shader');
    assert.deepEqual(raw.defines, { FOO: '1', HERO_HDR: '' }, 'HERO_HDR added, existing defines kept');
    assert.equal(raw.onBeforeCompile, undefined);
    const rad = mk({ isShaderMaterial: true, fragmentShader: 'gl_FragColor = heroRadiance (lin);' });
    assert.equal(adaptMaterialForHdr(rad, ADD), 'shader');
    const bad = mk({ isShaderMaterial: true, blending: ADD, fragmentShader: 'void main(){ gl_FragColor = vec4(c, a); }' });
    assert.equal(adaptMaterialForHdr(bad, ADD), 'unconverted');
    assert.equal(bad.defines, undefined, 'an unconverted shader is not switched to HDR');
}

console.log(`hero-color: all assertions passed (knee ${TONE.knee} linear = ${srgbEncode(TONE.knee).toFixed(3)} display)`);
