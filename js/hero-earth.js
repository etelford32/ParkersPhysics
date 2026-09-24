/**
 * hero-earth.js — PURE kernel for the homepage hero's Earth
 * ═══════════════════════════════════════════════════════════════════════════
 * No three.js, no DOM, no ambient time: every function takes what it needs,
 * so `node tests/hero-earth.mjs` pins all of it. The renderer
 * (js/hero-space-weather.js) draws only what this module decides.
 *
 * ── THE REAL SUN, WITHOUT MOVING THE CAMERA ────────────────────────────────
 * The hero's composition fixes the Sun's DIRECTION in the scene (SUN_DIR,
 * screen-left so the lit limb faces the copy). Real time is honoured by
 * turning the GLOBE instead: `earthOrientation(date, sunDir)` is the rotation
 * that carries the real sub-solar point (js/sun-altitude.js `subSolarPoint`
 * — the site's zero-dependency NOAA/Meeus solar position; not a sixth copy)
 * onto `sunDir`, with the geographic pole kept as close to scene +y as the
 * real geometry allows. That pins one more fact for free: the pole sits at
 * exactly (90° − sub-solar latitude) from the Sun, so the lit cap tilts with
 * the SEASON — June lights the Arctic, December darkens it. The terminator,
 * the continents in daylight and the city lights that are on are therefore
 * the ones that really are, right now.
 *
 * ── THE CANONICAL FRAME ────────────────────────────────────────────────────
 * Object space is js/geo/coords.js's frame (+X lon 0°, +Y north, −Z lon 90°E)
 * and the shader reads UV through coords.glsl.js `normalToUV`, so the texture,
 * the orientation and every other Earth on the site agree. `latLonToNormal`
 * below MIRRORS coords.js (which imports three and so cannot load here); the
 * test pins the axes.
 *
 * ── TEXTURE TIERS ──────────────────────────────────────────────────────────
 * assets/earth (see its SOURCES.md; built by scripts/build-hero-earth-textures.py).
 * `pickTextureTier` asks how many texels the RESTING disc needs across its
 * equator — 2π × its radius in device pixels — and only fetches the 4k day
 * map when 2k genuinely falls short and the visitor is not on save-data or
 * a phone. The boot tier always loads first so the entrance never waits on
 * the big file.
 */
import { subSolarPoint } from './sun-altitude.js';

const DEG = Math.PI / 180;

const EARTH_DIR = '/assets/earth/';
const tier = (dayW, auxW) => {
    const d = dayW === 4096 ? '4k' : dayW === 2048 ? '2k' : '1k';
    const a = auxW === 2048 ? '2k' : '1k';
    return Object.freeze({
        day: `${EARTH_DIR}day-${d}.webp`,
        water: `${EARTH_DIR}water-${a}.webp`,
        lights: `${EARTH_DIR}lights-${a}.webp`,
        relief: `${EARTH_DIR}relief-${a}.webp`,
        dayWidth: dayW,
        auxWidth: auxW,
    });
};

/** File table — moves in lockstep with scripts/build-hero-earth-textures.py. */
export const TEXTURE_TIERS = Object.freeze({
    boot: tier(1024, 1024),
    hd:   tier(2048, 2048),
    uhd:  tier(4096, 2048),
});

/** 2k must fall this far short before the 4k map (~810 KB) is worth fetching. */
export const UHD_SHORTFALL = 1.1;

/**
 * @param {object} o
 * @param {number}  o.restRadiusPx  Earth's resting disc radius in CSS px
 *                                  (hero-space-weather `--hero-disc-r`)
 * @param {number}  [o.dpr=1]
 * @param {boolean} [o.saveData=false]  navigator.connection.saveData
 * @param {boolean} [o.phone=false]     a phone-class viewport
 * @returns {'boot'|'hd'|'uhd'}  the tier to END on (boot always loads first)
 */
export function pickTextureTier({ restRadiusPx, dpr = 1, saveData = false, phone = false } = {}) {
    if (saveData) return 'boot';
    const need = 2 * Math.PI * Math.max(0, restRadiusPx || 0) * Math.max(1, dpr || 1);
    if (!phone && need > TEXTURE_TIERS.hd.dayWidth * UHD_SHORTFALL) return 'uhd';
    return 'hd';
}

/** Geographic (degrees) → unit normal in the canonical frame (mirror of js/geo/coords.js). */
export function latLonToNormal(latDeg, lonDeg) {
    const la = latDeg * DEG, lo = lonDeg * DEG, cl = Math.cos(la);
    return [cl * Math.cos(lo), Math.sin(la), -cl * Math.sin(lo)];
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const axpy = (a, s, b) => [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2]];

/**
 * Rotation matrix → quaternion [x, y, z, w] (three.js order).
 * @param {number[]} m row-major 3×3
 */
export function matrixToQuaternion(m) {
    const [m11, m12, m13, m21, m22, m23, m31, m32, m33] = m;
    const tr = m11 + m22 + m33;
    let x, y, z, w;
    if (tr > 0) {
        const s = 0.5 / Math.sqrt(tr + 1);
        w = 0.25 / s; x = (m32 - m23) * s; y = (m13 - m31) * s; z = (m21 - m12) * s;
    } else if (m11 > m22 && m11 > m33) {
        const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
        w = (m32 - m23) / s; x = 0.25 * s; y = (m12 + m21) / s; z = (m13 + m31) / s;
    } else if (m22 > m33) {
        const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
        w = (m13 - m31) / s; x = (m12 + m21) / s; y = 0.25 * s; z = (m23 + m32) / s;
    } else {
        const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
        w = (m21 - m12) / s; x = (m13 + m31) / s; y = (m23 + m32) / s; z = 0.25 * s;
    }
    return [x, y, z, w];
}

/**
 * The globe's orientation at `date` for a scene Sun along `sunDir`.
 *
 * Object→world rotation R with R·n(sub-solar) = sunDir and R·ŷ (the north
 * pole) = cos(φ☉)·t + sin(φ☉)·sunDir, where φ☉ is the sub-solar latitude and
 * t is scene +y with its sunDir component removed — the pole as close to "up"
 * as a pole at (90° − φ☉) from the Sun can be. Built as B·Aᵀ from two
 * orthonormal bases (sub-solar normal, local north, east) → (sunDir, t, …).
 *
 * @param {Date} date
 * @param {number[]} sunDir  unit-ish scene Sun direction [x, y, z]
 * @returns {{ matrix: number[], quaternion: number[], subsolar: {lat:number, lon:number}, pole: number[] }}
 */
export function earthOrientation(date, sunDir) {
    const ss = subSolarPoint(date);
    const S = norm(sunDir);
    const a1 = latLonToNormal(ss.lat, ss.lon);
    const a2 = norm(axpy([0, 1, 0], -a1[1], a1));          // local north at the sub-solar point
    const a3 = cross(a1, a2);
    const up = [0, 1, 0];
    const t = norm(axpy(up, -dot(up, S), S));               // scene up, perpendicular to the Sun
    const b3 = cross(S, t);
    // R = B·Aᵀ, columns of B = (S, t, b3), columns of A = (a1, a2, a3).
    const m = new Array(9);
    for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
            m[r * 3 + c] = S[r] * a1[c] + t[r] * a2[c] + b3[r] * a3[c];
        }
    }
    const pole = [m[1], m[4], m[7]];                        // R·ŷ
    return { matrix: m, quaternion: matrixToQuaternion(m), subsolar: ss, pole };
}

/**
 * Apply a row-major 3×3 to a vector (exported for the test and for callers
 * that need a world direction for a geographic point without three).
 */
export function applyMatrix(m, v) {
    return [
        m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
        m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
        m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
    ];
}
