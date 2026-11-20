/**
 * sun-camera.js — sun.html's camera: framing, flights and shots (PURE)
 * ═══════════════════════════════════════════════════════════════════════════
 * SUN_VISUALS_WORLD_CLASS_PLAN.md Phase 5. No three, no DOM, no clock of its
 * own — sun.html hands it numbers and applies what comes back. Gate:
 * `node tests/sun-camera.mjs`.
 *
 * ── A pose ───────────────────────────────────────────────────────────────
 *   { az, el, r, target: [x, y, z], fov }
 * The camera sits at spherical (az, el, r) ABOUT SUN CENTRE and looks at
 * `target`. az/el are the page's own convention — position =
 * r·(cos el·sin az, sin el, cos el·cos az) — which is Stonyhurst longitude and
 * latitude in the scene frame, so the Sun–Earth line is az = 0, el = B0 and a
 * flare site's direction is its own (lon, lat).
 *
 * ── Four rules, each of which was a bug somewhere on this site ───────────
 * 1. FLIGHTS INTERPOLATE THE SPHERICAL POSE, never Cartesian position. A
 *    straight line between two camera positions on opposite sides of the Sun
 *    goes THROUGH the Sun (sun.html's `flyToRegion` lerped positions and did
 *    exactly that on any far-side hop — the Boötes "dives through the void"
 *    scar). Azimuth takes the short way round; distance is interpolated in
 *    log r, so a pull-back from 3 to 70 R☉ spends its time evenly per octave.
 *    The gate asserts no sample of any flight is closer than its nearer end.
 * 2. THE PAGE MAY START A FLIGHT, IT MAY NOT HOLD THE CAMERA (the TIGA rule).
 *    A `Flight` is a one-shot: `sample()` returns `done` at the end and the
 *    caller stops applying it. There is no spring, no follow, no per-frame
 *    ease toward a goal. sun.html cancels on the controls' own 'start' event.
 * 3. TIME IS THE CALLER'S, in seconds. Easing is a function of elapsed TIME,
 *    never a per-frame fraction (a per-frame ease took 8 s on a software
 *    rasteriser on the TIGA stage).
 * 4. FRAMING IS MEASURED. The canvas is full-bleed under floating panels, so
 *    "centred" means centred in the unobstructed rectangle (`safeFrame`), and
 *    the hero distance is derived from the lens and that rectangle
 *    (`fitDistance`) — never a typed 6.
 *
 * ── The lens ─────────────────────────────────────────────────────────────
 * The page's lens was 50°. At 50° a disc that fills two thirds of the frame
 * needs the camera at ~3.5 R☉, and from there the sphere's own silhouette
 * hides the inner 4.6 % of the plane-of-sky off-limb ring (ρ < D/√(D²−1) —
 * js/sun-offlimb.js header, KNOWN LIMIT), i.e. the base of every prominence.
 * A longer lens from further back frames the same disc with the observer's
 * geometry intact: at HERO_FOV_DEG the hero distance is ~6 R☉ and the hidden
 * sliver is 1.4 %. It is also simply how the Sun is photographed.
 */

export const DEG = Math.PI / 180;

/** The page's default lens, degrees (vertical). See "The lens" above. */
export const HERO_FOV_DEG = 30;
/** The lens the page's older presets were tuned for. */
export const LEGACY_FOV_DEG = 50;
/** Disc DIAMETER as a fraction of the safe rectangle's shorter side, on load. */
export const HERO_FILL = 0.60;
/** OrbitControls bounds the page keeps (R☉). The coronagraph shots raise the far one. */
export const MIN_DISTANCE = 1.3;
export const MAX_DISTANCE = 60;
export const MAX_DISTANCE_CORONAGRAPH = 140;

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

// ── Framing ────────────────────────────────────────────────────────────────

/**
 * Distance at which a sphere of `radius` has an on-screen radius equal to
 * `fill` × the viewport's HALF-HEIGHT, for a vertical field of view `fovDeg`.
 * Exact for a sphere: its silhouette subtends asin(radius/D), so the projected
 * radius is tan(asin(radius/D)) / tan(fov/2) half-heights.
 */
export function fitDistance({ fovDeg, fill, radius = 1 }) {
    const t = clamp(fill, 1e-4, 1e4) * Math.tan(0.5 * fovDeg * DEG);
    return radius / Math.sin(Math.atan(t));
}

/** Inverse of fitDistance: the fill a sphere has from distance `d`. */
export function fillAt({ fovDeg, d, radius = 1 }) {
    return Math.tan(Math.asin(clamp(radius / d, 0, 0.999999))) / Math.tan(0.5 * fovDeg * DEG);
}

/** The distance under lens `fovTo` that frames the sphere as `d` did under `fovFrom`. */
export function equivalentDistance(d, fovFrom, fovTo, radius = 1) {
    return fitDistance({ fovDeg: fovTo, fill: fillAt({ fovDeg: fovFrom, d, radius }), radius });
}

/**
 * The largest unobstructed rectangle of a `w`×`h` viewport, given the boxes
 * of the chrome floating over it (CSS px, viewport coordinates).
 *
 * Not a general maximal-rectangle solver — the page's chrome is docked to
 * edges, so each box is charged to the edge it hugs: a box that spans most of
 * the width trims top or bottom; a box that spans most of the height (or is a
 * side panel, tall enough to matter) trims left or right; a small corner box
 * is charged to whichever trim costs less area. A box crossing the central
 * band is IGNORED (it is a dialog, and the Sun should not move for it).
 *
 * @returns {{left:number, top:number, right:number, bottom:number, w:number, h:number,
 *            cx:number, cy:number, offsetX:number, offsetY:number}}
 *   offsetX/offsetY: how far the safe centre is from the viewport centre —
 *   what `camera.setViewOffset` needs (negated) to put the Sun there.
 */
export function safeFrame({ w, h }, rects = [], { minSide = 220 } = {}) {
    let left = 0, top = 0, right = w, bottom = h;
    for (const r of rects) {
        if (!r) continue;
        const rl = clamp(r.left, 0, w), rr = clamp(r.right, 0, w);
        const rt = clamp(r.top, 0, h), rb = clamp(r.bottom, 0, h);
        const rw = rr - rl, rh = rb - rt;
        if (rw <= 1 || rh <= 1) continue;
        const crossesCentre = rl < 0.42 * w && rr > 0.58 * w && rt < 0.42 * h && rb > 0.58 * h;
        if (crossesCentre) continue;
        // What each trim would cost, if this box were charged to that edge.
        const cand = [];
        if (rl < 0.5 * w)  cand.push(['left',   Math.max(rr - left, 0) * (bottom - top)]);
        if (rr > 0.5 * w)  cand.push(['right',  Math.max(right - rl, 0) * (bottom - top)]);
        if (rt < 0.5 * h)  cand.push(['top',    Math.max(rb - top, 0) * (right - left)]);
        if (rb > 0.5 * h)  cand.push(['bottom', Math.max(bottom - rt, 0) * (right - left)]);
        // A full-width bar can only be a top/bottom trim; a full-height one only left/right.
        const wide = rw > 0.6 * w, tall = rh > 0.6 * h;
        const ok = cand.filter(([e]) => !(wide && (e === 'left' || e === 'right')) && !(tall && (e === 'top' || e === 'bottom')));
        const pick = (ok.length ? ok : cand).sort((a, b) => a[1] - b[1])[0];
        if (!pick || pick[1] <= 0) continue;
        if (pick[0] === 'left')   left   = Math.max(left, rr);
        if (pick[0] === 'right')  right  = Math.min(right, rl);
        if (pick[0] === 'top')    top    = Math.max(top, rb);
        if (pick[0] === 'bottom') bottom = Math.min(bottom, rt);
    }
    // Never let chrome squeeze the stage below a usable size: give back to the
    // full viewport on the axis that collapsed (a phone with a sheet open).
    if (right - left < minSide) { left = 0; right = w; }
    if (bottom - top < minSide) { top = 0; bottom = h; }
    const cx = 0.5 * (left + right), cy = 0.5 * (top + bottom);
    return { left, top, right, bottom, w: right - left, h: bottom - top, cx, cy,
             offsetX: cx - 0.5 * w, offsetY: cy - 0.5 * h };
}

/**
 * Hero framing for a viewport: the fill (in half-heights of the FULL
 * viewport, which is what the projection is defined against) that makes the
 * disc `HERO_FILL` of the safe rectangle's shorter side, and the distance
 * that gives it.
 */
export function heroFraming({ w, h }, safe, { fovDeg = HERO_FOV_DEG, heroFill = HERO_FILL } = {}) {
    const side = Math.min(safe.w, safe.h);
    const fill = clamp((heroFill * side) / h, 0.05, 0.95);       // disc radius / half-height == diameter / height
    return { fill, distance: clamp(fitDistance({ fovDeg, fill }), MIN_DISTANCE, MAX_DISTANCE), fovDeg };
}

// ── Poses ──────────────────────────────────────────────────────────────────

export function sphToVec(az, el, r = 1) {
    const ce = Math.cos(el);
    return [r * ce * Math.sin(az), r * Math.sin(el), r * ce * Math.cos(az)];
}

export function vecToSph(v) {
    const r = Math.hypot(v[0], v[1], v[2]) || 1e-9;
    return { az: Math.atan2(v[0], v[2]), el: Math.asin(clamp(v[1] / r, -1, 1)), r };
}

/** Signed shortest angular step from a to b, radians, in (−π, π]. */
export function shortAngle(a, b) {
    let d = (b - a) % (2 * Math.PI);
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d <= -Math.PI) d += 2 * Math.PI;
    return d;
}

export function makePose({ az = 0, el = 0, r = 6, target = [0, 0, 0], fov = HERO_FOV_DEG } = {}) {
    return { az, el, r, target: [target[0], target[1], target[2]], fov };
}

/** Pose from a Cartesian camera position + target (what the page reads off OrbitControls). */
export function poseFromCamera(position, target = [0, 0, 0], fov = HERO_FOV_DEG) {
    const s = vecToSph(position);
    return makePose({ az: s.az, el: s.el, r: s.r, target, fov });
}

export function posePosition(p) { return sphToVec(p.az, p.el, p.r); }

/** Smootherstep — zero velocity AND acceleration at both ends, so a flight never jerks. */
export function ease(u) {
    const x = clamp(u, 0, 1);
    return x * x * x * (x * (x * 6 - 15) + 10);
}

/**
 * Pose between a and b at eased parameter u ∈ [0, 1]. Spherical (rule 1):
 * azimuth the short way, elevation linear, distance in log r, target and
 * lens linear.
 */
export function lerpPose(a, b, u) {
    const k = clamp(u, 0, 1);
    return {
        az: a.az + shortAngle(a.az, b.az) * k,
        el: a.el + (b.el - a.el) * k,
        r: Math.exp(Math.log(a.r) + (Math.log(b.r) - Math.log(a.r)) * k),
        target: [0, 1, 2].map((i) => a.target[i] + (b.target[i] - a.target[i]) * k),
        fov: a.fov + (b.fov - a.fov) * k,
    };
}

// ── Flights ────────────────────────────────────────────────────────────────

/**
 * A flight is a list of keyframes `{ t, pose, hold? }`, t in seconds from
 * the start, strictly increasing. Between two keys the pose is `lerpPose` at
 * the smootherstep of the segment's own fraction, unless the SECOND key says
 * `linear: true` (a continuous move — a pan, a push-in — that must not stop
 * and restart at every key).
 */
export function flightDuration(keys) { return keys.length ? keys[keys.length - 1].t : 0; }

export function sampleFlight(keys, tSec) {
    if (!keys.length) return null;
    if (tSec <= keys[0].t) return keys[0].pose;
    const last = keys[keys.length - 1];
    if (tSec >= last.t) return last.pose;
    let i = 1;
    while (i < keys.length - 1 && keys[i].t < tSec) i++;
    const a = keys[i - 1], b = keys[i];
    const f = (tSec - a.t) / Math.max(b.t - a.t, 1e-9);
    return lerpPose(a.pose, b.pose, b.linear ? f : ease(f));
}

/** One-shot runner (rule 2). `now` is the caller's clock, seconds. */
export class Flight {
    constructor(keys, { name = 'flight', startS = 0 } = {}) {
        this.keys = keys; this.name = name; this.startS = startS;
        this.duration = flightDuration(keys);
        this.cancelled = false;
    }
    cancel() { this.cancelled = true; }
    /** @returns {{pose:object|null, done:boolean, progress:number}} */
    sample(nowS) {
        if (this.cancelled) return { pose: null, done: true, progress: 1 };
        const t = nowS - this.startS;
        const done = t >= this.duration;
        return { pose: sampleFlight(this.keys, t), done, progress: this.duration > 0 ? clamp(t / this.duration, 0, 1) : 1 };
    }
}

/** Seconds a hop of this size deserves: longer for a bigger turn or a bigger change of scale. */
export function hopSeconds(a, b, { min = 1.1, max = 4.5 } = {}) {
    const ang = Math.hypot(shortAngle(a.az, b.az), b.el - a.el);
    const oct = Math.abs(Math.log2(b.r / a.r));
    return clamp(0.9 + 1.25 * ang + 0.55 * oct, min, max);
}

/** A single eased hop from one pose to another. */
export function hop(from, to, seconds = hopSeconds(from, to)) {
    return [{ t: 0, pose: from }, { t: seconds, pose: to }];
}

// ── Shots ──────────────────────────────────────────────────────────────────
// Each returns keyframes starting FROM the current pose, so a shot can begin
// wherever the user left the camera. Angles in radians, distances in R☉.

/** The Earth-line hero pose: what the page opens on. */
export function heroPose({ b0Rad = 0, distance, fov = HERO_FOV_DEG }) {
    return makePose({ az: 0, el: b0Rad, r: distance, fov });
}

/**
 * APPROACH — from deep space down the Sun–Earth line to the hero frame.
 * Starts a little off-axis and high so the disc drifts into place rather
 * than only growing.
 */
export function approachShot(from, hero, { far = 34, seconds = 11 } = {}) {
    const start = makePose({ az: hero.az - 0.16, el: hero.el + 0.07, r: far, fov: hero.fov });
    const cut = hopSeconds(from, start, { min: 0.01, max: 1.6 });
    return [
        { t: 0, pose: from },
        { t: cut, pose: start },
        { t: cut + seconds, pose: hero },
    ];
}

/**
 * LIMB PAN — a long lens tracking along the limb. The camera stays within
 * `maxOffAxis` of the Sun–Earth line ON PURPOSE: the observed off-limb ring
 * (js/sun-offlimb.js) is at full weight only inside 12° of it, and this shot
 * exists to show that ring. The move is in the TARGET, which travels the
 * limb circle in the plane of sky from position angle pa0 to pa1 (radians,
 * 0 = solar north, increasing toward EAST = −x, the astronomer's convention).
 *
 * `basis` is js/sun-offlimb.js `observerBasis(b0)` — { right, up, normal }.
 */
export function limbPanShot(from, { basis, pa0 = 60 * DEG, pa1 = 130 * DEG, distance = 5.2, fov = 13,
    rho = 1.04, seconds = 26, maxOffAxis = 7 * DEG } = {}) {
    const at = (pa) => {
        const x = -Math.sin(pa) * rho, y = Math.cos(pa) * rho;       // east is −x on the sky
        return [0, 1, 2].map((i) => basis.right[i] * x + basis.up[i] * y);
    };
    const n = vecToSph(basis.normal);
    const lean = (pa) => clamp(-Math.sin(pa) * 0.09, -maxOffAxis, maxOffAxis);   // lean a few degrees toward the limb being shown
    const steps = 6, keys = [];
    const first = makePose({ az: n.az + lean(pa0), el: n.el, r: distance, target: at(pa0), fov });
    const cut = hopSeconds(from, first, { min: 1.2, max: 3.2 });
    keys.push({ t: 0, pose: from }, { t: cut, pose: first });
    for (let i = 1; i <= steps; i++) {
        const pa = pa0 + (pa1 - pa0) * (i / steps);
        keys.push({ t: cut + seconds * (i / steps), linear: true,
            pose: makePose({ az: n.az + lean(pa), el: n.el, r: distance, target: at(pa), fov }) });
    }
    return keys;
}

/**
 * FLARE — cut to a flare site. The camera is tilted off the site's own
 * zenith TOWARD the Earth direction by `tilt` (so the arcade is seen
 * obliquely, standing off the surface, and the view stays on the observed
 * hemisphere), never past the Earth line. A disc-centre flare has no
 * "toward Earth" to tilt along; it tilts toward solar north instead.
 *
 * @param {number[]} site   unit vector of the site NOW, scene frame
 * @param {number[]} earth  unit vector of the Sun–Earth line (observerBasis.normal)
 * @param {string} cls      GOES class letter — bigger flares are framed wider
 */
/** The flare's ribbons (their 1/e length) as a fraction of the frame height in the flare shot. */
export const FLARE_FILL = 0.42;
/** The flare shot never comes closer to Sun centre than this (R☉): the arcade stands up to ~0.1 R☉ tall. */
export const FLARE_MIN_R = 1.45;
/**
 * The flare close-up. With `length` (the ribbons' 1/e length, radians of arc —
 * js/flare-geometry.js ribbonLength0 × 2) the camera distance is DERIVED so
 * that length fills FLARE_FILL of the frame: a C-class event is framed as
 * tightly as an X-class one, each at its own size. Without it the typed
 * per-class distances are the fallback (they framed every flare at ~0.7 R☉
 * of frame height, in which a real-size arcade was a sixth of the picture).
 */
export function flareShot(from, { site, earth, cls = 'M', tilt = 52 * DEG, seconds = 18, length = null } = {}) {
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const sep = Math.acos(clamp(dot(site, earth), -1, 1));
    // Tangent at the site pointing toward Earth (or north at disc centre).
    let ref = sep > 6 * DEG ? earth : [0, 1, 0];
    let t = [0, 1, 2].map((i) => ref[i] - dot(ref, site) * site[i]);
    let tl = Math.hypot(t[0], t[1], t[2]);
    if (tl < 1e-6) { ref = [1, 0, 0]; t = [0, 1, 2].map((i) => ref[i] - dot(ref, site) * site[i]); tl = Math.hypot(t[0], t[1], t[2]); }
    t = t.map((x) => x / tl);
    // Never tilt past the Earth line: a limb flare (sep ≈ 90°) gets the full tilt, a near-centre one less.
    const psi = sep > 6 * DEG ? Math.min(tilt, sep) : tilt * 0.75;
    const dir = [0, 1, 2].map((i) => site[i] * Math.cos(psi) + t[i] * Math.sin(psi));
    const s = vecToSph(dir);
    const L = String(cls || 'M')[0].toUpperCase();
    let r0 = L === 'X' ? 2.9 : L === 'M' ? 2.6 : 2.4;
    const fov = L === 'X' ? 20 : 17;
    const RT = 1.012;                                   // the target sits just above the site
    if (length > 0) {
        // Camera–target distance that makes `length` fill FLARE_FILL of the frame,
        // then the radius on the tilted ray that is that far from the target.
        const D = length / (FLARE_FILL * 2 * Math.tan(fov * DEG / 2));
        const sp = RT * Math.sin(psi);
        r0 = Math.max(FLARE_MIN_R, RT * Math.cos(psi) + Math.sqrt(Math.max(D * D - sp * sp, 0)));
    }
    const tgt = site.map((x) => x * RT);
    const arrive = makePose({ az: s.az, el: s.el, r: r0, target: tgt, fov });
    const settle = makePose({ az: s.az + 0.05, el: s.el, r: Math.max(MIN_DISTANCE + 0.05, r0 * 0.86), target: tgt, fov });
    const cut = hopSeconds(from, arrive, { min: 1.4, max: 3.6 });
    return [
        { t: 0, pose: from },
        { t: cut, pose: arrive },
        { t: cut + seconds, pose: settle, linear: true },     // a slow push-in while the arcade grows
    ];
}

/**
 * CORONA — pull back down the Sun–Earth line until the coronagraph fields
 * fill the frame: first to where a field of `c2Reach` R☉ fills `fill` of the
 * half-height, then to `c3Reach`. Reaches are passed in (js/sun-coronagraph.js
 * owns them); the distances are DERIVED from the lens, not typed.
 */
export function coronaShot(from, { b0Rad = 0, fov = HERO_FOV_DEG, c2Reach = 6, c3Reach = 30, fill = 0.86,
    seconds = 22, hold = 5 } = {}) {
    const dC2 = fitDistance({ fovDeg: fov, fill, radius: c2Reach });
    const dC3 = fitDistance({ fovDeg: fov, fill, radius: c3Reach });
    const p2 = makePose({ az: 0, el: b0Rad, r: dC2, fov });
    const p3 = makePose({ az: 0, el: b0Rad, r: Math.min(dC3, MAX_DISTANCE_CORONAGRAPH), fov });
    const cut = hopSeconds(from, p2, { min: 1.5, max: 4.5 });
    const leg = seconds * 0.5;
    return [
        { t: 0, pose: from },
        { t: cut + leg * 0.6, pose: p2 },
        { t: cut + leg * 0.6 + hold, pose: p2 },
        { t: cut + leg * 0.6 + hold + leg, pose: p3 },
        { t: cut + leg * 0.6 + hold + leg + hold, pose: p3 },
    ];
}

/** ORBIT — a slow turn about the Sun at constant distance: the far side, the model half, comes round. */
export function orbitShot(from, { sweep = 150 * DEG, el = 0.22, distance, seconds = 30 } = {}) {
    const r = distance ?? from.r;
    const steps = 6, keys = [{ t: 0, pose: from }];
    const first = makePose({ az: from.az, el, r, fov: from.fov });
    const cut = hopSeconds(from, first, { min: 0.6, max: 2.5 });
    keys.push({ t: cut, pose: first });
    for (let i = 1; i <= steps; i++) {
        keys.push({ t: cut + seconds * (i / steps), linear: true,
            pose: makePose({ az: from.az + sweep * (i / steps), el, r, fov: from.fov }) });
    }
    return keys;
}

/**
 * The cinematic loop's running order. `have` says what the page can show, so
 * a shot whose subject is absent is skipped rather than played over nothing
 * (no coronagraph frame ⇒ no pull-back to an empty sky).
 */
export function cinematicOrder({ coronagraph = false, offLimb = false, flare = false } = {}) {
    const order = ['approach'];
    if (flare) order.push('flare');
    if (offLimb) order.push('limb');
    order.push('orbit');
    if (coronagraph) order.push('corona');
    return order;
}

export const SHOT_TITLES = Object.freeze({
    approach: 'Approach',
    limb: 'Limb · the observed off-limb ring',
    flare: 'Flare site',
    orbit: 'Orbit · observed side to model side',
    corona: 'Pull-back · SOHO/LASCO coronagraphs',
    hero: 'Earth view',
});
