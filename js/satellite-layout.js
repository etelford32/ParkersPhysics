/**
 * satellite-layout.js — where every part of a build physically sits
 * ════════════════════════════════════════════════════════════════════════════
 *
 * PURE (no DOM, no THREE). layoutBuild() takes a build and places EVERY item
 * of satellite-builder.js massBreakdown() in the bus frame:
 *
 *   • tanks            aft, symmetric about the thrust axis (placeTanks)
 *   • battery / wheels / flight computer   packed inside the bus envelope
 *                      around the tanks (packInternals)
 *   • extras           packed on their chosen face around the reserved
 *                      footprints (payload, thruster cluster, launch-adapter
 *                      ring, array drives, radiator band, RCS pods)
 *   • wings, thrusters, payload, RCS pods, body cells — fixed rules
 *
 * The SAME placement drives three consumers, which is the point:
 *   js/satellite-parts-3d.js   draws each part where it is placed
 *   massProperties()           centre of mass + inertia tensor
 *   js/satellite-engineering.js  thrust-misalignment torque, gravity-gradient
 *                              torque, packaging checks
 * so a dish moved to +Y shifts the drawn dish, the CG and the review together.
 *
 * Gate: tests/satellite-components.mjs — the placed masses sum to
 * deriveDesign().dryMass, nothing overlaps, everything sits inside its face /
 * envelope, and a symmetric build keeps its CG on the thrust axis.
 */

import { BODIES, THRUSTER_UNITS, PANELS, PAYLOADS, resolveBuild, massBreakdown } from './satellite-builder.js';
import {
    TANKS, BATTERIES, ADCS_UNITS, OBC_UNITS, EXTRAS, FACES, FACE_KEYS, PAYLOAD_FOOTPRINT,
    bodyClass, payloadScale, innerEnvelope, placeTanks, packInternals, faceGeometry, packFace,
    tankCapacityKg,
} from './satellite-components.js';

/** Visual length (m) of one thruster unit behind the aft deck. */
export function thrusterLength(key) {
    const tu = THRUSTER_UNITS[key];
    if (!tu) return 0.1;
    if (key === 'hall_ion' || key === 'hall_shielded') return tu.nozzle * 1.6;
    if (key === 'gridded_ion' || key === 'iodine_ion') return tu.nozzle * 1.8;
    if (key === 'electrospray') return tu.nozzle * 0.9;
    return tu.nozzle * 3.6;                 // chamber + bell
}
/** Exit diameter of one thruster unit (for cluster spacing). */
export function thrusterDiameter(key) {
    const tu = THRUSTER_UNITS[key];
    if (!tu) return 0.1;
    if (key === 'hall_ion' || key === 'hall_shielded' || key === 'gridded_ion') return tu.nozzle * 2.6;
    return tu.nozzle * 2.2;
}

/** Height (m) the payload stands above the deck at full scale. */
export const PAYLOAD_HEIGHT = { scope: 0.48, imager: 0.32, dish: 0.62, plate: 0.12, array: 0.10, driver: 1.6 };

/** Thruster-cluster grid (shared by layout and mesh). */
export function thrusterGrid(body, key, count, bodyKey = '') {
    const [dx, dy] = body.dims;
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    // CubeSats fly the miniaturised variant of each thruster class: the
    // cluster is drawn scaled to fit the deck (same rule as the payload).
    let scale = 1;
    if (bodyClass(bodyKey) === 'cubesat') {
        const natural = Math.max(cols, rows) * thrusterDiameter(key) * 1.12;
        scale = Math.min(1, Math.min(dx, dy) * 0.85 / natural);
    }
    const dia = thrusterDiameter(key) * scale;
    const pitch = Math.max(Math.min(dx, dy) * 0.7 / cols, dia * 1.12);
    const pos = [];
    for (let i = 0; i < count; i++) {
        const cx = (i % cols) - (cols - 1) / 2;
        const cy = Math.floor(i / cols) - (rows - 1) / 2;
        pos.push([cx * pitch, cy * pitch]);
    }
    return { pos, pitch, cols, rows, dia, scale,
             w: (cols - 1) * pitch + dia, h: (rows - 1) * pitch + dia };
}

/** Launch-adapter ring radius on the aft deck (0 for CubeSats, which ride rails). */
export function adapterRing(body, bodyKey) {
    if (bodyClass(bodyKey) === 'cubesat') return null;
    const [dx, dy] = body.dims;
    const r = Math.min(dx, dy) * 0.36;
    return { r, w: Math.max(0.02, r * 0.09) };
}

/** RCS pod positions (bus corners near the forward deck). */
export function rcsPods(body) {
    const [dx, dy, dz] = body.dims;
    const cyl = body.shape === 'cyl' || body.shape === 'tube';
    const out = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
        const p = cyl
            ? [sx * dx / 2 * Math.SQRT1_2, sy * dx / 2 * Math.SQRT1_2, dz * 0.30]
            : [sx * dx / 2, sy * dy / 2, dz * 0.30];
        out.push({ c: p, dir: [sx * Math.SQRT1_2, sy * Math.SQRT1_2, 0] });
    }
    return out;
}

const add3 = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const absMix = (u, v, n, w, h, t) => [0, 1, 2].map(i => Math.abs(u[i]) * w + Math.abs(v[i]) * h + Math.abs(n[i]) * t);

/**
 * Lay out a build. Returns
 *   { rb, body, env, parts:[…], issues:[…], bbox:{min,max}, extent }
 * Each part: { id, slot, key, kind, label, subsystem, mass, c, s, vis,
 *              face?, n?, u?, v?, internal, fits, …kind params }.
 */
export function layoutBuild(build, tierMods = null) {
    const rb = build && build.auto ? build : resolveBuild(build);
    const body = BODIES[rb.body];
    const [dx, dy, dz] = body.dims;
    const env = innerEnvelope(body, rb.body);
    const cube = bodyClass(rb.body) === 'cubesat';
    const breakdown = massBreakdown(rb, tierMods);
    const byslot = (slot) => breakdown.filter(it => it.slot === slot);
    const parts = [];
    const issues = [];
    const push = (p) => { parts.push({ internal: false, fits: true, ...p, vis: p.vis || p.s }); };

    // ── Bus structure ─────────────────────────────────────────────────────
    const busIt = byslot('bus')[0];
    push({ id: 'bus', slot: 'bus', key: rb.body, kind: 'bus', label: busIt.label, subsystem: 'structure',
           mass: busIt.mass, c: [0, 0, 0], s: [dx, dy, dz] });
    const har = byslot('harness')[0];
    push({ id: 'harness', slot: 'harness', key: 'harness', kind: 'harness', label: har.label,
           subsystem: 'power', mass: har.mass, c: [0, 0, env.zc], s: env.size.slice(), internal: true, hidden: true });

    // ── Thrusters (aft deck, pointing −Z) ────────────────────────────────
    const thrIt = byslot('thruster')[0];
    const grid = thrusterGrid(body, rb.thruster, rb.thrusterCount, rb.body);
    const tLen = thrusterLength(rb.thruster) * grid.scale;
    grid.pos.forEach(([x, y], i) => push({
        id: `thruster-${i}`, slot: 'thruster', key: rb.thruster, kind: 'thruster', label: thrIt.label,
        subsystem: 'propulsion', mass: thrIt.mass / rb.thrusterCount,
        c: [x, y, -dz / 2 - tLen * 0.42], s: [grid.dia, grid.dia, tLen], index: i, length: tLen, scale: grid.scale,
    }));
    const deckMin = Math.min(dx, dy);
    if (grid.w > deckMin * 1.02 || grid.h > deckMin * 1.02) {
        issues.push({ sev: 'warn', id: 'layout.thrusters',
            msg: `${rb.thrusterCount}× ${THRUSTER_UNITS[rb.thruster].label} (${grid.w.toFixed(2)} m cluster) overhangs the ${deckMin.toFixed(2)} m aft deck.` });
    }

    // ── Solar wings (±X) ─────────────────────────────────────────────────
    const pan = PANELS[rb.panel];
    const panIt = byslot('panel')[0];
    if (pan.wings > 0) {
        const perSide = pan.wings / 2;
        const span = rb.panelSpan, chord = rb.panelChord;
        const root = cube ? 0.01 : 0.12;     // CubeSat wings hinge at the face edge
        for (const sgn of [-1, 1]) for (let k = 0; k < perSide; k++) {
            const zoff = perSide > 1 ? (k - (perSide - 1) / 2) * (chord + 0.08) : 0;
            push({ id: `wing-${sgn > 0 ? 'p' : 'm'}${k}`, slot: 'panel', key: rb.panel, kind: 'wing',
                   label: panIt.label, subsystem: 'power', mass: panIt.mass / pan.wings,
                   c: [sgn * (dx / 2 + root + span / 2), 0, zoff], s: [span, 0.03, chord],
                   side: sgn, k, span, chord, zoff, root });
        }
    }

    // ── Payload (+Z deck) ────────────────────────────────────────────────
    const pl = PAYLOADS[rb.payload];
    const plIt = byslot('payload')[0];
    const plS = payloadScale(rb.body, body.dims, pl.shape);
    let payloadFoot = null;
    if (pl.shape) {
        const fp = PAYLOAD_FOOTPRINT[pl.shape] || [0.3, 0.3];
        const h = (PAYLOAD_HEIGHT[pl.shape] || 0.3) * plS;
        const zBase = dz / 2 + (body.shape === 'tube' ? -dz * 0.02 : 0);
        push({ id: 'payload', slot: 'payload', key: rb.payload, kind: 'payload', shape: pl.shape,
               label: plIt.label, subsystem: 'payload', mass: plIt.mass,
               c: [0, 0, zBase + h / 2], s: [fp[0] * plS, fp[1] * plS, h], scale: plS, zBase });
        payloadFoot = { u: 0, v: 0, w: Math.min(fp[0] * plS, dx), h: Math.min(fp[1] * plS, dy) };
    }

    // ── Tanks (internal, aft) ────────────────────────────────────────────
    const tank = TANKS[rb.tank];
    const tIt = byslot('tank')[0];
    const tp = placeTanks(env, tank, rb.tankCount);
    const cap1 = tankCapacityKg(tank, rb.thruster);
    tp.items.forEach((it, i) => push({
        id: `tank-${i}`, slot: 'tank', key: rb.tank, kind: 'tank', label: tank.label, subsystem: 'propulsion',
        mass: tIt.mass / rb.tankCount, c: it.c, s: it.s, axis: it.axis, internal: true, fits: tp.fits,
        capacityKg: cap1, index: i,
    }));
    if (!tp.fits) {
        issues.push({ sev: 'fail', id: 'layout.tanks',
            msg: `${rb.tankCount}× ${tank.label} does not fit inside the ${body.label} (${env.size.map(v => v.toFixed(2)).join(' × ')} m usable).` });
    }

    // ── Other internals ──────────────────────────────────────────────────
    const bat = BATTERIES[rb.battery], ad = ADCS_UNITS[rb.adcs], ob = OBC_UNITS[rb.obc];
    const internals = packInternals(env, [
        { id: 'adcs', slot: 'adcs', key: rb.adcs, kind: 'adcs', label: ad.label, subsystem: 'adcs', mass: ad.mass, s: ad.dims },
        { id: 'battery', slot: 'battery', key: rb.battery, kind: 'battery', label: bat.label, subsystem: 'power', mass: bat.mass, s: bat.dims },
        { id: 'obc', slot: 'obc', key: rb.obc, kind: 'obc', label: ob.label, subsystem: 'avionics', mass: ob.mass, s: ob.dims },
    ], tp.fits ? tp.items.map(it => ({ ...it, sphere: tank.shape === 'sphere' ? tank.d : 0 })) : []);
    for (const it of internals) {
        push({ ...it, internal: true });
        if (!it.fits) issues.push({ sev: 'fail', id: `layout.${it.slot}`,
            msg: `${it.label} does not fit inside the ${body.label} alongside the tanks.` });
    }

    // ── RCS pods ─────────────────────────────────────────────────────────
    const kitIt = byslot('rcs')[0];
    const podsVisible = !!kitIt || (rb.rcs === 'auto' && !!body.rcs);
    const podR = Math.min(dx, dy) * 0.07 + 0.012;
    if (podsVisible) {
        rcsPods(body).forEach((p, i) => push({
            id: `rcs-${i}`, slot: 'rcs', key: rb.rcs, kind: 'rcs', label: kitIt ? kitIt.label : 'Bus RCS cluster',
            subsystem: 'propulsion', mass: kitIt ? kitIt.mass / 4 : 0, c: p.c, s: [podR * 2, podR * 2, podR * 2],
            dir: p.dir, podR, index: i,
        }));
    }

    // ── Body-mounted cells (face coatings) ───────────────────────────────
    const cellIt = byslot('cells')[0];
    if (cellIt) {
        const areas = rb.bodyCells.map(f => {
            const g = faceGeometry(body, f);
            const frac = (f === '+Y' || f === '-Y') ? (1 - rb.radiator) : 1;
            return g.W * g.H * frac;
        });
        const tot = areas.reduce((a, b) => a + b, 0) || 1;
        rb.bodyCells.forEach((f, i) => {
            const F = FACES[f], g = faceGeometry(body, f);
            push({ id: `cells-${f}`, slot: 'cells', key: 'body_cells', kind: 'cells', label: 'Body-mounted cells',
                   subsystem: 'power', mass: cellIt.mass * areas[i] / tot, face: f, n: F.n, u: F.u, v: F.v,
                   c: F.n.map(x => x * g.d), s: absMix(F.u, F.v, F.n, g.W, g.H, 0.002), hidden: true });
        });
    }

    // ── Radiator bands (±Y, OSR tiles) — mass is in the bus structure ────
    if (rb.radiator > 0) {
        for (const f of ['+Y', '-Y']) {
            const F = FACES[f], g = faceGeometry(body, f);
            push({ id: `radiator-${f}`, slot: 'radiator', key: 'osr', kind: 'radband', label: 'OSR radiator panel',
                   subsystem: 'thermal', mass: 0, face: f, n: F.n, u: F.u, v: F.v, frac: rb.radiator,
                   c: F.n.map(x => x * g.d), s: absMix(F.u, F.v, F.n, g.W, g.H * rb.radiator, 0.002) });
        }
    }

    // ── Face reservations ────────────────────────────────────────────────
    const reserved = Object.fromEntries(FACE_KEYS.map(f => [f, []]));
    if (payloadFoot) reserved['+Z'].push(payloadFoot);
    if (body.tug) reserved['+Z'].push({ ring: true, rIn: dx * 0.42 - 0.06, rOut: dx * 0.42 + 0.06 });
    if (body.shape === 'tube') reserved['+Z'].push({ u: 0, v: 0, w: dx, h: dy });
    reserved['-Z'].push({ u: 0, v: 0, w: grid.w, h: grid.h });
    const ring = adapterRing(body, rb.body);
    if (ring) reserved['-Z'].push({ ring: true, rIn: ring.r - ring.w, rOut: ring.r + ring.w });
    if (cube) {   // corner rails run the full length on ±Z
        for (const f of ['+Z', '-Z']) for (const su of [-1, 1]) for (const sv of [-1, 1]) {
            reserved[f].push({ u: su * (dx / 2 - 0.006), v: sv * (dy / 2 - 0.006), w: 0.014, h: 0.014 });
        }
    }
    if (pan.wings > 0) {
        const sada = cube ? 0.02 : Math.min(0.18, dy * 0.4);
        const perSide = pan.wings / 2;
        for (const f of ['+X', '-X']) for (let k = 0; k < perSide; k++) {
            const zoff = perSide > 1 ? (k - (perSide - 1) / 2) * (rb.panelChord + 0.08) : 0;
            // A CubeSat wing hinges along a thin line at the face centre.
            reserved[f].push(cube ? { u: 0, v: zoff, w: 0.004, h: Math.min(rb.panelChord, dz) }
                                  : { u: 0, v: zoff, w: sada, h: sada });
        }
    }
    if (rb.radiator > 0) {      // radiator band, centred on ±Y
        for (const f of ['+Y', '-Y']) {
            const g = faceGeometry(body, f);
            reserved[f].push({ u: 0, v: 0, w: g.W, h: g.H * rb.radiator });
        }
    }
    if (podsVisible && body.shape !== 'cyl' && body.shape !== 'tube') {
        for (const f of ['+X', '-X', '+Y', '-Y']) {
            const g = faceGeometry(body, f);
            for (const su of [-1, 1]) reserved[f].push({ u: su * g.W / 2, v: dz * 0.30, w: podR * 3, h: podR * 3 });
        }
    }

    // ── Extras ───────────────────────────────────────────────────────────
    for (const f of FACE_KEYS) {
        const onFace = rb.extras.map((e, i) => ({ e, i })).filter(x => x.e.face === f);
        if (!onFace.length) continue;
        const g = faceGeometry(body, f);
        const F = FACES[f];
        // Pack big items first (they are the hard ones), but keep a stable
        // order within equal sizes so a build always lays out the same way.
        const order = onFace.slice().sort((a, b) => {
            const A = EXTRAS[a.e.k].foot, B = EXTRAS[b.e.k].foot;
            return B[0] * B[1] - A[0] * A[1] || a.i - b.i;
        });
        const packed = packFace(g, order.map(x => ({ foot: EXTRAS[x.e.k].foot, ref: x })), reserved[f]);
        for (const pk of packed) {
            const { e, i } = pk.ref;
            const x = EXTRAS[e.k];
            const base = g.curvedR ? Math.sqrt(Math.max(0, g.curvedR ** 2 - pk.u ** 2)) : g.d;
            const p0 = add3(add3(F.n.map(q => q * base), F.u, pk.u), F.v, pk.v);
            push({ id: `extra-${i}`, slot: 'extra', key: e.k, kind: x.kind, label: x.label, subsystem: x.subsystem,
                   mass: x.mass, face: f, n: F.n, u: F.u, v: F.v, base: p0, fu: pk.u, fv: pk.v,
                   c: add3(p0, F.n, x.height / 2), s: absMix(F.u, F.v, F.n, x.foot[0], x.foot[1], x.height),
                   vis: absMix(F.u, F.v, F.n, x.foot[0] + 2 * (x.reach || 0), x.foot[1] + 2 * (x.reach || 0),
                               x.height + (x.reach || 0)),
                   index: i, fits: pk.fits });
            if (!pk.fits) issues.push({ sev: 'fail', id: `layout.extra-${i}`,
                msg: `${x.label} has no room on ${FACES[f].label}.` });
        }
    }

    // ── Bounding box (for camera framing) ────────────────────────────────
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const p of parts) {
        if (p.hidden) continue;
        for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k], p.c[k] - p.vis[k] / 2);
            max[k] = Math.max(max[k], p.c[k] + p.vis[k] / 2);
        }
    }
    const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    return { rb, body, env, parts, issues, bbox: { min, max }, extent, grid };
}

/** Largest bounding dimension (m) — what the cameras frame. */
export function buildExtent(build) {
    return layoutBuild(build).extent;
}

/**
 * Mass properties about the centre of mass. `fuelKg` (optional) is loaded
 * into the tanks in proportion to their capacity. Each part is a uniform
 * solid box of its size — coarse, stated, and enough for the CG offset and
 * the gravity-gradient |I_max − I_min| the review needs.
 * @returns {{mass, cg:number[], I:number[3][3], principal:number[]}}
 */
export function massProperties(layout, fuelKg = 0) {
    const pts = layout.parts.filter(p => p.mass > 0).map(p => ({ m: p.mass, c: p.c, s: p.s }));
    const tanks = layout.parts.filter(p => p.slot === 'tank');
    if (fuelKg > 0 && tanks.length) {
        const capTot = tanks.reduce((a, t) => a + (t.capacityKg || 1), 0);
        for (const t of tanks) {
            pts.push({ m: fuelKg * (t.capacityKg || 1) / capTot, c: t.c, s: t.s.map(x => x * 0.8) });
        }
    }
    const M = pts.reduce((a, p) => a + p.m, 0) || 1;
    const cg = [0, 1, 2].map(k => pts.reduce((a, p) => a + p.m * p.c[k], 0) / M);
    const I = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const p of pts) {
        const [sx, sy, sz] = p.s;
        const r = [p.c[0] - cg[0], p.c[1] - cg[1], p.c[2] - cg[2]];
        const own = [p.m * (sy * sy + sz * sz) / 12, p.m * (sx * sx + sz * sz) / 12, p.m * (sx * sx + sy * sy) / 12];
        const r2 = r[0] ** 2 + r[1] ** 2 + r[2] ** 2;
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
            I[i][j] += (i === j ? own[i] + p.m * r2 : 0) - p.m * r[i] * r[j];
        }
    }
    return { mass: M, cg, I, principal: principalMoments(I) };
}

/** Eigenvalues of a symmetric 3×3 (closed form, Smith 1961), ascending. */
export function principalMoments(A) {
    const p1 = A[0][1] ** 2 + A[0][2] ** 2 + A[1][2] ** 2;
    if (p1 < 1e-18) return [A[0][0], A[1][1], A[2][2]].sort((a, b) => a - b);
    const q = (A[0][0] + A[1][1] + A[2][2]) / 3;
    const p2 = (A[0][0] - q) ** 2 + (A[1][1] - q) ** 2 + (A[2][2] - q) ** 2 + 2 * p1;
    const p = Math.sqrt(p2 / 6);
    const B = A.map((row, i) => row.map((v, j) => (v - (i === j ? q : 0)) / p));
    const detB = B[0][0] * (B[1][1] * B[2][2] - B[1][2] * B[2][1])
               - B[0][1] * (B[1][0] * B[2][2] - B[1][2] * B[2][0])
               + B[0][2] * (B[1][0] * B[2][1] - B[1][1] * B[2][0]);
    const r = Math.max(-1, Math.min(1, detB / 2));
    const phi = Math.acos(r) / 3;
    const e1 = q + 2 * p * Math.cos(phi);
    const e3 = q + 2 * p * Math.cos(phi + 2 * Math.PI / 3);
    const e2 = 3 * q - e1 - e3;
    return [e3, e2, e1];
}
