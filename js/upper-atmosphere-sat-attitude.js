/**
 * upper-atmosphere-sat-attitude.js — which way a spacecraft faces, where
 * its shadow is, and where it is over the ground
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE (plain arrays; node-gated by tests/upper-atmosphere-sat-attitude.mjs).
 * Units: scene R⊕ (1 = 6371 km), seconds, radians unless a name says Deg.
 *
 * THE ATTITUDE IS A MODEL AND SAYS SO. Nothing in a TLE carries attitude,
 * so the kernel assigns each model family its NOMINAL mode — the way that
 * class of spacecraft is flown — and the follow card prints the mode name:
 *   • lvlh-xvv  (stations): body −Z along the velocity, +Y radial out, the
 *                arrays alpha-tracking the Sun about the truss (one axis —
 *                the ISS also has beta gimbals; not modelled, disclosed);
 *   • nadir     (comms, nav, Earth observation, generic): antenna face to
 *                nadir, −Z along the velocity, the wing alpha-tracking;
 *   • inertial  (observatories): the target is unknown, so the arrays face
 *                the Sun and the tube is held 90° from it;
 *   • tumble    (rocket bodies, debris): uncontrolled, a slow spin about a
 *                body axis seeded by the object's id so no two tumble alike.
 *
 * THE SUN GEOMETRY IS PHYSICS. From the position, the velocity and the sun
 * direction alone: the beta angle (Sun to orbit plane), the critical beta
 * above which an orbit sees no eclipse (sin β > 1/r), and the illumination
 * — umbra / penumbra / sunlit from the Earth's and the Sun's angular radii
 * at the spacecraft, the penumbra fraction LINEAR across the Sun's disc (a
 * disclosed approximation; the true curve is a chord-area integral).
 *
 * THE GROUND TRACK IS THE SAME PROPAGATOR. `groundTrackSamples` takes a
 * `positionAt(ms)` in the EARTH-FIXED scene (the globe hands it the object's
 * own propagator turned by GMST at each sample's own instant — never the
 * inertial path drawn on an Earth-fixed globe) and projects it to the
 * surface; the sub-satellite lat/lon is in the page's one frame (+X
 * Greenwich, +Y north, −Z = 90°E), pinned against the column kernel.
 *
 * BODY FRAME (satellite-models.js): −Z = ram, +Y = radial out, X = cross-
 * track. `attitudeBasis` returns the body axes as WORLD vectors {x, y, z};
 * the renderer builds a rotation matrix from them. Solar arrays rotate
 * about body X; `arrayAlpha` gives the angle that points their +Y normal at
 * the Sun and the cosine of the incidence they achieve.
 */

export const SUN_ANGULAR_RADIUS = 0.004652;   // rad (0.2666°) at 1 AU

export const ATTITUDE_MODES = Object.freeze({
    iss:      { id: 'lvlh-xvv', label: 'LVLH · velocity forward, nadir down', arrays: 'alpha-tracking' },
    hubble:   { id: 'inertial', label: 'inertial pointing · arrays to Sun, tube 90° off it', arrays: 'fixed-to-sun' },
    starlink: { id: 'nadir',    label: 'nadir-pointing · wing tracks the Sun', arrays: 'alpha-tracking' },
    iridium:  { id: 'nadir',    label: 'nadir-pointing · antennas down', arrays: 'alpha-tracking' },
    generic:  { id: 'nadir',    label: 'nadir-pointing (nominal)', arrays: 'alpha-tracking' },
    rocket:   { id: 'tumble',   label: 'uncontrolled · slow tumble', arrays: 'none', rateRadS: 0.6 * Math.PI / 180 },
    debris:   { id: 'tumble',   label: 'uncontrolled · tumble', arrays: 'none', rateRadS: 3.0 * Math.PI / 180 },
});

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const n = norm(a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const perp = (a, n) => sub(a, scale(n, dot(a, n)));   // a with its component along unit n removed

/** Rotate v about unit axis k by angle a (Rodrigues). */
export function rotateAbout(v, k, a) {
    const c = Math.cos(a), s = Math.sin(a);
    const kv = cross(k, v), kd = dot(k, v);
    return [
        v[0] * c + kv[0] * s + k[0] * kd * (1 - c),
        v[1] * c + kv[1] * s + k[1] * kd * (1 - c),
        v[2] * c + kv[2] * s + k[2] * kd * (1 - c),
    ];
}

/** A small deterministic hash → [0, 1), for per-object tumble axes. */
export function hash01(seed) {
    let h = 2166136261 >>> 0;
    const s = String(seed ?? '');
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    // FNV-1a over one or two bytes barely avalanches ('a' and 'b' came out
    // 0.004 apart and two debris pieces tumbled about the same axis):
    // murmur3's final mix spreads them.
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h ^= h >>> 16;
    return (h >>> 8) / 16777216;
}

/** The LVLH triad { up, along, cross } (same construction as sat-view's). */
export function lvlh(pos, vel) {
    const up = unit(pos);
    let t = vel ? perp(vel, up) : [0, 0, 0];
    if (norm(t) < 1e-9) { t = cross([0, 1, 0], up); if (norm(t) < 1e-9) t = [1, 0, 0]; }
    const along = unit(t);
    return { up, along, cross: cross(up, along) };
}

/**
 * The body axes as world vectors for a family's nominal mode.
 * @param {object} o
 * @param {string} o.family   iss | hubble | starlink | iridium | generic | rocket | debris
 * @param {number[]} o.pos    Earth-fixed scene position
 * @param {number[]} o.vel    velocity direction (any length)
 * @param {number[]} o.sunDir unit vector toward the Sun
 * @param {number} [o.tS]     seconds (tumble phase)
 * @param {string|number} [o.id] seed for the tumble axis
 * @returns {{ x:number[], y:number[], z:number[], mode:object }}
 */
export function attitudeBasis({ family = 'generic', pos, vel, sunDir, tS = 0, id = 0 }) {
    const mode = ATTITUDE_MODES[family] || ATTITUDE_MODES.generic;
    const L = lvlh(pos, vel);
    const s = unit(sunDir || [1, 0, 0]);
    let y, z;
    if (mode.id === 'inertial') {
        // Arrays to the Sun (+Y = s); the tube (−Z) 90° from it, as close to
        // the ram direction as that allows (a stable, sun-safe choice).
        y = s;
        let b = perp(scale(L.along, -1), s);
        if (norm(b) < 1e-9) b = perp(L.cross, s);
        z = unit(b);
    } else {
        y = L.up;
        z = scale(L.along, -1);
    }
    let x = unit(cross(y, z));
    let axis = null;
    if (mode.id === 'tumble') {
        // A slow spin about a body-fixed axis seeded by the id (a tumble
        // ABOUT the nadir frame: the frame still turns with the orbit).
        axis = tumbleAxis(id, { x, y, z });
        const a = (mode.rateRadS || 0.01) * tS;
        x = rotateAbout(x, axis, a); y = rotateAbout(y, axis, a); z = rotateAbout(z, axis, a);
    }
    return { x, y, z, mode, axis };
}

/** The tumble axis for an id: a direction on the sphere from two hashes, expressed in the given basis. */
export function tumbleAxis(id, basis) {
    const u = hash01(id), v = hash01(String(id) + 'k');
    const th = Math.acos(2 * u - 1), ph = 2 * Math.PI * v;
    const a = Math.sin(th) * Math.cos(ph), b = Math.sin(th) * Math.sin(ph), c = Math.cos(th);
    return unit([a * basis.x[0] + b * basis.y[0] + c * basis.z[0], a * basis.x[1] + b * basis.y[1] + c * basis.z[1], a * basis.x[2] + b * basis.y[2] + c * basis.z[2]]);
}

/** A world vector expressed in the body frame of a basis. */
export function toBody(v, basis) { return [dot(v, basis.x), dot(v, basis.y), dot(v, basis.z)]; }

/**
 * Solar-array alpha: the rotation about body X that turns the array's +Y
 * normal toward the Sun, and the cosine of the incidence it then achieves
 * (1 = square on; the component of the Sun along the X axis is what a
 * single gimbal cannot remove).
 */
export function arrayAlpha(sunBody) {
    const sy = sunBody[1], sz = sunBody[2];
    const m = Math.hypot(sy, sz);
    return { alphaRad: m > 1e-9 ? Math.atan2(sz, sy) : 0, cosIncidence: clamp(m, 0, 1) };
}

/**
 * Illumination at a position: 'sunlit' | 'penumbra' | 'umbra', the lit
 * fraction (linear across the Sun's disc in the penumbra — disclosed), and
 * the angles behind it. `sunDir` points TOWARD the Sun.
 */
export function illumination(pos, sunDir) {
    const r = norm(pos);
    if (!(r > 1)) return { state: 'umbra', fraction: 0, thetaDeg: 0, earthRadDeg: 90 };
    const s = unit(sunDir);
    const toEarth = scale(unit(pos), -1);
    const theta = Math.acos(clamp(dot(toEarth, s), -1, 1));   // Earth-centre to Sun, seen from the craft
    const rhoE = Math.asin(1 / r), rhoS = SUN_ANGULAR_RADIUS;
    let state, fraction;
    if (theta <= rhoE - rhoS) { state = 'umbra'; fraction = 0; }
    else if (theta >= rhoE + rhoS) { state = 'sunlit'; fraction = 1; }
    else { state = 'penumbra'; fraction = clamp((theta - (rhoE - rhoS)) / (2 * rhoS), 0, 1); }
    return { state, fraction, thetaDeg: theta * 180 / Math.PI, earthRadDeg: rhoE * 180 / Math.PI };
}

/**
 * The beta angle (Sun to orbit plane, signed by the orbit normal p × v),
 * the critical beta above which this orbit sees no eclipse (sin β = 1/r),
 * and whether it is currently eclipse-free.
 */
export function betaAngle(pos, vel, sunDir) {
    const h = unit(cross(pos, vel));
    const s = unit(sunDir);
    const beta = Math.asin(clamp(dot(s, h), -1, 1));
    const r = norm(pos);
    const crit = r > 1 ? Math.asin(1 / r) : Math.PI / 2;
    return { betaDeg: beta * 180 / Math.PI, criticalDeg: crit * 180 / Math.PI, eclipseFree: Math.abs(beta) > crit };
}

/** Sub-satellite point in the page's frame (+X Greenwich, +Y north, −Z = 90°E). */
export function subSatellite(pos, reKm = 6371) {
    const r = norm(pos);
    const latDeg = Math.asin(clamp(pos[1] / (r || 1), -1, 1)) * 180 / Math.PI;
    const lonDeg = Math.atan2(-pos[2], pos[0]) * 180 / Math.PI;
    return { latDeg, lonDeg, altKm: (r - 1) * reKm, surface: unit(pos) };
}

/**
 * The ground track about `nowMs`: `past` and `future` as surface points
 * (unit direction × surfaceR) sampled every stepS from positionAt(ms), an
 * Earth-fixed scene position, plus the current sub-satellite point. A
 * sample positionAt cannot give (null / non-finite) ends that side.
 */
export function groundTrackSamples({ positionAt, nowMs, pastS = 2700, futureS = 5400, stepS = 30, surfaceR = 1.0015 }) {
    const side = (dir, span) => {
        const out = [];
        for (let k = 1; k * stepS <= span; k++) {
            const p = positionAt(nowMs + dir * k * stepS * 1000);
            if (!p || !Number.isFinite(p[0]) || norm(p) < 0.5) break;
            out.push(scale(unit(p), surfaceR));
        }
        return out;
    };
    const p0 = positionAt(nowMs);
    const ok = p0 && Number.isFinite(p0[0]) && norm(p0) >= 0.5;
    const past = side(-1, pastS).reverse();
    const future = side(1, futureS);
    return { past, future, now: ok ? { ...subSatellite(p0), point: scale(unit(p0), surfaceR) } : null };
}

/**
 * The next shadow boundary ahead: scans positionAt forward every stepS up
 * to horizonS and returns { kind: 'enter'|'exit', inS, state } for the first
 * change of illumination state (penumbra counts with the side it is
 * nearer: a crossing is reported at the first sample not 'sunlit' when
 * starting lit, and at the first 'sunlit' sample when starting dark), or
 * null when none occurs within the horizon (an eclipse-free orbit).
 */
export function nextShadowEvent({ positionAt, nowMs, sunDir, stepS = 20, horizonS = 7200 }) {
    const p0 = positionAt(nowMs);
    if (!p0) return null;
    const lit0 = illumination(p0, sunDir).state === 'sunlit';
    for (let k = 1; k * stepS <= horizonS; k++) {
        const p = positionAt(nowMs + k * stepS * 1000);
        if (!p || !Number.isFinite(p[0])) return null;
        const lit = illumination(p, sunDir).state === 'sunlit';
        if (lit !== lit0) return { kind: lit ? 'exit' : 'enter', inS: k * stepS, from: lit0 ? 'sunlit' : 'shadow' };
    }
    return null;
}
