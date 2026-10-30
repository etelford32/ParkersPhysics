/**
 * earth-surface-light.mjs — the physics of EarthView's lit surface
 * ═══════════════════════════════════════════════════════════════════════════
 * Pins js/earth-surface-light.js (PURE) — the model earth.html's surface
 * shader compiles under EARTH_PHYSICAL_LIGHT — and that its GLSL mirror reads
 * the SAME constants. The browser half (final pixels, with the legacy path as
 * the negative control) is tests/earth-surface-light.spec.js.
 *
 * Run: node tests/earth-surface-light.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    SURFACE_LIGHT as S, airMass, beamRel, skyIrradiance, fresnel, coxMunkVariance,
    glint, pathRadiance, cityLights, darkness, shadeSurface, srgbEncode, EARTH_LIGHT_GLSL,
} from '../js/earth-surface-light.js';
import { MAX_WIND_MS } from '../js/weather-decode.js';

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg} (got ${a}, want ${b} ± ${tol})`);
const srgbDecode = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const ALBEDO = [0.20, 0.16, 0.10];   // a mid-latitude land pixel, linear

// The legacy surface, transcribed from js/earth-skin.js's #else branch (flat
// ground, no ocean): the reference the new model is judged against.
function legacy(albedo, NdotL) {
    const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    const dayMix = sm(-0.10, 0.20, NdotL);
    const halfLamb = Math.min(1, Math.max(0, NdotL * 0.5 + 0.5));
    const lit = 0.35 + (halfLamb - 0.35) * dayMix;
    return albedo.map(a => a * (0.55 + 0.45 * dayMix) * lit);
}

// ── 1. Air mass + the zenith white balance ─────────────────────────────────
near(airMass(1), 1, 1e-3, 'air mass at the zenith ≈ 1');
ok(airMass(0) > 35 && airMass(0) < 40, `air mass at the horizon is Kasten–Young's ~38 (got ${airMass(0)})`);
ok(beamRel(1).every(t => Math.abs(t - 1) < 1e-12), 'the zenith beam is the white point (map reproduced at the sub-solar point)');

// ── 2. The terminator reddens BY PHYSICS ───────────────────────────────────
let prevRB = 0;
for (const mu of [1, 0.7, 0.4, 0.2, 0.1, 0.05, 0.02]) {
    const b = beamRel(mu);
    ok(b[0] >= b[1] && b[1] >= b[2], `μ=${mu}: red survives the slant path best, blue worst`);
    const rb = b[0] / b[2];
    ok(rb >= prevRB, `μ=${mu}: red/blue rises toward the terminator`);
    prevRB = rb;
}
ok(prevRB > 3, `the low-Sun beam is distinctly orange-red (R/B ${prevRB.toFixed(2)})`);

// ── 3. Sub-solar nadir: the map, untouched except the skylight ─────────────
{
    const r = shadeSurface({ albedo: ALBEDO, mu0: 1, muS: 1, muV: 1, cosScatter: -1 });
    ok(r.path.every(p => p === 0), 'no aerial-perspective haze looking straight down');
    ok(r.view.every(v => Math.abs(v - 1) < 1e-12), 'no extra view extinction looking straight down');
    r.rgb.forEach((c, i) => near(c, ALBEDO[i] * (1 + S.sky[i]), 1e-12, `noon nadir channel ${i} = albedo × (beam + sky)`));
}

// ── 4. Lambert, not half-Lambert: real contrast across the day side ────────
{
    const at = (mu) => shadeSurface({ albedo: ALBEDO, mu0: mu, muS: mu, muV: 1 }).rgb[1];
    const ratio = at(0.25) / at(1);
    const legacyRatio = legacy(ALBEDO, 0.25)[1] / legacy(ALBEDO, 1)[1];
    ok(ratio < 0.36, `μ☉ = 0.25 is ≤ ~a third of noon (Lambert + extinction): ${ratio.toFixed(3)}`);
    ok(legacyRatio > 0.6, `negative control: the legacy half-Lambert kept ${legacyRatio.toFixed(3)} there`);
}

// ── 5. The night side is DARK ──────────────────────────────────────────────
for (const muS of [-0.3, -0.6, -1]) {
    const r = shadeSurface({ albedo: ALBEDO, mu0: 0, muS, muV: 1 });
    const leg = legacy(ALBEDO, muS);
    ok(r.rgb.every((c, i) => c <= ALBEDO[i] * S.nightFloor + 1e-12), `μ☉=${muS}: only starlight + airglow (≤ ${S.nightFloor} × albedo)`);
    ok(r.rgb[1] / leg[1] < 0.05, `μ☉=${muS}: ≥ 20× darker than the legacy daylit-photo night (${(leg[1] / ALBEDO[1]).toFixed(3)} × albedo)`);
}

// ── 6. City lights are EMITTERS, on after civil twilight ───────────────────
{
    const code = (c) => srgbDecode(c / 255);                 // the night map's linear red for byte code c
    near(cityLights(code(13)), 0, 0, 'the moonlit base (R ≤ 13) is not a lamp');
    near(cityLights(code(16)), 0, 1e-9, 'the measured floor is zero lamp');
    near(cityLights(code(106)), 1, 1e-9, 'floor + span is a saturated core');
    near(cityLights(code(61)), 0.5, 1e-9, 'linear in byte code between');
    const lampAt = (muS, albedo) =>
        shadeSurface({ albedo, mu0: 0, muS, muV: 1, nightRed: code(106) }).rgb[0]
        - shadeSurface({ albedo, mu0: 0, muS, muV: 1, nightRed: 0 }).rgb[0];
    near(lampAt(0.3, ALBEDO), 0, 1e-12, 'no lamps in daylight');
    near(lampAt(-0.05, ALBEDO), 0, 1e-12, 'no lamps before civil twilight (Sun −3°)');
    near(lampAt(-0.25, ALBEDO), S.lamp[0] * S.lampGain, 1e-12, 'full lamps after nautical twilight');
    near(lampAt(-0.25, [0, 0, 0]), lampAt(-0.25, [0.4, 0.4, 0.4]), 1e-12, 'a lamp does not depend on the ground it sits on (not lit, emitted)');
    ok(darkness(-0.15) > 0 && darkness(-0.15) < 1, 'lamps ramp on through the twilight band');
    const off = shadeSurface({ albedo: ALBEDO, mu0: 0, muS: -0.5, muV: 1, nightRed: code(106), cityOn: 0 }).rgb[0];
    near(off, ALBEDO[0] * S.nightFloor, 1e-12, 'the Lights layer switches the lamps off');
}

// ── 7. Ocean: Fresnel + Cox–Munk ───────────────────────────────────────────
near(fresnel(1), S.waterF0, 1e-12, 'Fresnel at normal incidence is water F0 = 0.02');
near(fresnel(0), 1, 1e-12, 'Fresnel at grazing is total reflection');
{
    let prev = 0;
    for (const c of [1, 0.8, 0.5, 0.3, 0.1, 0]) { ok(fresnel(c) >= prev, `Fresnel rises toward grazing (cos ${c})`); prev = fresnel(c); }
}
near(coxMunkVariance(MAX_WIND_MS), 0.003 + 0.00512 * S.windClampMs[1], 1e-12, 'σ² clamps at the fit range');
near(coxMunkVariance(0), 0.003 + 0.00512 * S.windClampMs[0], 1e-12, 'no wind data → the calm floor');
near(coxMunkVariance(7), 0.003 + 0.00512 * 7, 1e-12, 'Cox & Munk 1954: σ² = 0.003 + 0.00512·w');
{
    // Beckmann D is a normalised slope density: ∫ D cosθ dω = 1.
    for (const w of [2, 7, 15]) {
        const s2 = coxMunkVariance(w);
        let sum = 0; const N = 20000;
        for (let i = 0; i < N; i++) {
            const th = (i + 0.5) / N * Math.PI / 2, c = Math.cos(th), c2 = c * c;
            const D = Math.exp(-(1 - c2) / (c2 * s2)) / (Math.PI * s2 * c2 * c2);
            sum += D * c * Math.sin(th) * 2 * Math.PI * (Math.PI / 2 / N);
        }
        near(sum, 1, 0.01, `Cox–Munk D integrates to 1 at ${w} m/s`);
    }
    // A calm sea is a sharp bright mirror, a gale a wide dull patch.
    const g = (w, off) => {
        const h = Math.cos(off);   // half-vector tilted `off` from the normal, Sun + camera overhead-ish
        return glint({ NdH: h, NdV: 0.9, NdL: 0.9, VdH: 0.95, s2: coxMunkVariance(w) });
    };
    ok(g(2, 0) > 2 * g(15, 0), 'the glint core is far brighter on a calm sea');
    ok(g(15, 0.25) / g(15, 0) > g(2, 0.25) / g(2, 0), 'the glint spreads wider under wind');
    // Fresnel lifts the glint toward grazing geometry.
    const flat = (vh) => glint({ NdH: 1, NdV: 0.5, NdL: 0.5, VdH: vh, s2: 0.02 });
    ok(flat(0.2) > 5 * flat(0.95), 'the same slope reflects far more at a grazing half-angle (Fresnel)');
}
{
    const sea = (muV) => shadeSurface({ albedo: S.deepOcean, water: 1, mu0: 0.5, muS: 0.5, muV, cosScatter: 0, NdH: 0.2, VdH: 0.5 });
    const land = (muV) => shadeSurface({ albedo: S.deepOcean, water: 0, mu0: 0.5, muS: 0.5, muV, cosScatter: 0, NdH: 0.2, VdH: 0.5 });
    near(sea(1).rgb[2] - land(1).rgb[2], 0, 1e-12, 'the sky reflection adds nothing at nadir (the map holds F0 already)');
    ok(sea(0.15).rgb[2] > land(0.15).rgb[2], 'water reflects more sky toward the limb');
}

// ── 8. Aerial perspective ──────────────────────────────────────────────────
{
    const p = (muS, muV, cosScatter = 0) => pathRadiance({ muS, muV, cosScatter });
    ok(p(0.6, 1).every(x => x === 0), 'no haze at nadir');
    let prev = -1;
    for (const muV of [1, 0.7, 0.4, 0.2, 0.1, 0.02]) {
        const b = p(0.6, muV)[2];
        ok(b >= prev, `haze grows toward the limb (μv ${muV})`);
        prev = b;
    }
    const day = p(0.6, 0.15);
    ok(day[2] > day[1] && day[1] > day[0], 'sunlit limb haze is blue (Rayleigh)');
    const dusk = p(0.0, 0.15);
    ok(dusk[0] > dusk[2], 'air over the terminator is lit by a reddened beam: the twilight band is red');
    ok(p(-0.1, 0.15).every(x => x === 0), 'air inside the Earth\'s shadow scatters nothing');
    ok(p(0.6, 0.15, 0.9)[2] > p(0.6, 0.15, 0)[2], 'looking toward the Sun brightens the haze (forward scatter)');
    const r = shadeSurface({ albedo: ALBEDO, mu0: 0.6, muS: 0.6, muV: 0.02 });
    ok(r.view[2] < 0.05, 'at the limb the ground itself is nearly extinguished; the haze replaces it');
}

// ── 9. The GLSL mirror reads the SAME numbers ──────────────────────────────
{
    const f = (x) => Number(x).toFixed(6);
    for (const [k, v] of Object.entries(S)) {
        const vals = Array.isArray(v) ? v : [v];
        for (const x of vals) ok(EARTH_LIGHT_GLSL.includes(f(x)), `GLSL carries SURFACE_LIGHT.${k} = ${x}`);
    }
    ok(EARTH_LIGHT_GLSL.includes(f(MAX_WIND_MS)), 'GLSL decodes the wind with weather-decode.js MAX_WIND_MS');
    ok(!EARTH_LIGHT_GLSL.includes('`'), 'no backtick inside the GLSL literal');
    for (const fn of ['elAirMass', 'elBeamRel', 'elSkyIrradiance', 'elFresnel', 'elCoxMunkVariance',
                      'elGlint', 'elPathRadiance', 'elSrgbEncode', 'elCityLights', 'elDarkness']) {
        ok(new RegExp(`\\b(float|vec3) ${fn}\\(`).test(EARTH_LIGHT_GLSL), `GLSL defines ${fn}`);
    }
    const skin = readFileSync(new URL('../js/earth-skin.js', import.meta.url), 'utf8');
    ok(skin.includes("from './earth-surface-light.js'"), 'earth-skin imports the ONE lighting kernel');
    ok(/#ifdef EARTH_PHYSICAL_LIGHT\n\$\{EARTH_LIGHT_GLSL\}\n#endif/.test(skin), 'the kernel GLSL compiles only on the opt-in path');
    ok(skin.includes("'#define EARTH_PHYSICAL_LIGHT\\n' + EARTH_FRAG"), 'EARTH_FRAG_PHYSICAL is EARTH_FRAG + the define');
    const page = readFileSync(new URL('../earth.html', import.meta.url), 'utf8');
    ok(/fragmentShader: EARTH_SURFACE_FRAG,\s*\n/.test(page) && (page.match(/fragmentShader: EARTH_SURFACE_FRAG/g) || []).length === 2,
        'earth.html hands the SAME shader text to the globe and the terrain patch');
}

// ── 10. The lamp floor is the hero builder's measured one ──────────────────
{
    const py = readFileSync(new URL('../scripts/build-hero-earth-textures.py', import.meta.url), 'utf8');
    const floor = Number(py.match(/^LIGHTS_FLOOR\s*=\s*([\d.]+)/m)?.[1]);
    const span = Number(py.match(/^LIGHTS_SPAN\s*=\s*([\d.]+)/m)?.[1]);
    near(S.lightsFloorCode, floor, 0, 'lights floor == scripts/build-hero-earth-textures.py LIGHTS_FLOOR');
    near(S.lightsSpanCode, span, 0, 'lights span == scripts/build-hero-earth-textures.py LIGHTS_SPAN');
    near(srgbEncode(srgbDecode(0.5)), 0.5, 1e-12, 'srgbEncode inverts the hardware decode');
}

// skyIrradiance is the hero's term: gone by deep twilight, full by μ☉ 0.3.
ok(skyIrradiance(-0.2).every(x => x === 0) && skyIrradiance(0.5).every((x, i) => x === S.sky[i]), 'skylight spans civil twilight → day');

console.log(`earth-surface-light: ${n} assertions passed`);
