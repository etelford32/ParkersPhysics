/**
 * bootes-force-probe.js — measure the force at ANY point around the Boötes Void
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE. No DOM, no fetch, no ambient time, no three.js. The probe on
 * bootes-void.html computes nothing of its own: it calls this module, and this
 * module only ever ASKS the two kernels that already exist —
 * js/bootes-void-model.js for the analytic spherical fields and
 * js/bootes-web-model.js for the clumped wall — and adds up what they say.
 * `node tests/bootes-force-probe.mjs` pins every sum below as an identity.
 *
 * WHAT A PROBE ANSWERS
 * ────────────────────
 * The rest of the page answers its eight questions along RADIAL PROFILES and
 * across a fixed set of sample shells. That is the right summary and the wrong
 * way to explore: a reader who wants to know "what pulls on a galaxy sitting
 * HERE — between those two filaments, just inside the wall?" has to read it off
 * a median and a 16–84 band. The probe evaluates the whole chain at one point,
 * any point, as it is dragged:
 *
 *   forces     the peculiar acceleration split FIVE ways, each with its radial
 *              and tangential part relative to the void centre:
 *                void   δ⁻ — the deficit alone (Test 4's Δg)
 *                wall   δ⁺ — the wall as a SMOOTH spherical shell
 *                web    the same wall mass, CLUMPED into the modelled web
 *                A      void + web — the real universe as modelled
 *                B      web alone — "no Boötes"
 *              plus `clumping` = web − smooth wall, which is the part of the
 *              force that exists only because the wall is lumpy. At the void
 *              centre and far outside it that term carries the anisotropy the
 *              spherical charts cannot show.
 *   who pulls  the web force broken down by STRUCTURE — each model node and
 *              each filament — with each one's share of the web force PROJECTED
 *              on the web force's own direction, so the shares sum to exactly
 *              one and a filament pulling sideways is not credited for it.
 *   velocity   the linear-theory peculiar velocity the local acceleration
 *              implies, v = 2 f g / (3 Ωm(z) H(z)). An identity, not a fit:
 *              for the void alone it IS `radialVelocityKms(..., {linear:true})`
 *              and the test asserts that to 1e-12.
 *   tidal      the full tidal tensor (void + web) in 4πGρ̄_m, its eigen-axes,
 *              the stretch/squeeze each axis applies across a 10 Mpc rod, and
 *              the T-web class the eigenvalues imply (Hahn et al. 2007;
 *              Forero-Romero et al. 2009) — how a cosmic-web classifier would
 *              label this point.
 *   potential  Φ in (km/s)², void (analytic, exact tail) + web (softened point
 *              masses). A void is a potential HILL; the probe shows it.
 *
 * SIGN CONVENTIONS ARE THE MODEL KERNEL'S, UNCHANGED. g is the peculiar
 * acceleration (Hubble flow removed), positive radial = AWAY from the void
 * centre. A void does not push — less inward pull from the empty side — and
 * `radial > 0` for the void term is that statement, not a repulsion.
 *
 * WHAT A PROBE CANNOT ANSWER, and the page says so beside it
 * ──────────────────────────────────────────────────────────
 *  - The web is a SEEDED SYNTHETIC realisation (js/bootes-web-model.js header).
 *    The web, clumping and contributor rows are a property of THIS realisation;
 *    re-rolling the seed moves them. The void and smooth-wall rows do not move.
 *  - The T-web class depends on the softening of the web's point masses: at a
 *    probe within ~ε of a node the tensor is the softened sphere's, which is
 *    exactly right for the extended object the softening defines and is not a
 *    statement about structure below ε. `softeningMpc` travels with the result.
 *  - The velocity is LINEAR. The spherical quasi-linear boost on the page's
 *    Test 1 chart (≈ 9 % at Δ = −0.4) has no non-spherical generalisation that
 *    would be honest to apply to a clumped field, so the probe does not apply
 *    one and says "linear".
 *  - A streamline is a curve tangent to the PRESENT-DAY velocity field. It is
 *    where matter is heading now at each point it passes, not the path any one
 *    galaxy took or will take (in the Zel'dovich approximation those paths are
 *    straight lines; streamlines are not).
 */

import {
    COSMOLOGY, G_SI, MPC_M, MSUN_KG, GYR_S,
    splitProfile, voidGravityVector, voidTidalTensor, symmetricEigen,
    growthRate, omegaMatterAt, hubbleSI, fourPiGRhoM,
} from './bootes-void-model.js';

/** Length of the rod the tidal "stretch" readout is quoted across, comoving Mpc. */
export const TIDAL_ROD_MPC = 10;

/**
 * Default T-web threshold, in 4πGρ̄_m (the unit in which tr T = δ).
 *
 * λ_th = 0 is Hahn et al.'s original choice and labels almost the entire volume
 * a sheet or filament because every tiny compression counts; Forero-Romero et
 * al. (2009) found 0.2–0.4 reproduces the visual web in simulations. 0.2 sits at
 * the bottom of that range. It is a CLASSIFIER SETTING, not physics — the page
 * exposes it and prints it with every class it reports.
 */
export const DEFAULT_TWEB_THRESHOLD = 0.2;

export const TWEB_CLASSES = Object.freeze(['void', 'sheet', 'filament', 'knot']);

const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const norm3 = (a) => Math.hypot(a[0], a[1], a[2]);

/** m/s² → km/s per Gyr, the unit this page prints accelerations in. */
export const toKmsPerGyr = (gSI) => gSI * GYR_S / 1000;

/**
 * Split a vector into its part along the radial unit vector from the void
 * centre and the magnitude of what is left. At the centre itself there is no
 * radial direction; the radial part is reported as 0 and `tangential` carries
 * the whole magnitude, which is the honest reading (nothing about that vector
 * is "outward").
 */
export function radialSplit(vector, radialUnit) {
    const mag = norm3(vector);
    if (!radialUnit) return { vector, magnitude: mag, radial: 0, tangential: mag };
    const radial = dot3(vector, radialUnit);
    // The residual vector, not √(|v|² − v_r²): the square-root form cancels
    // catastrophically for a purely radial field and reported a spurious
    // ~1e-8 |v| tangential part on the void term, which is exactly radial.
    const tangential = norm3(sub3(vector, scale3(radialUnit, radial)));
    return { vector, magnitude: mag, radial, tangential };
}

/**
 * The linear-theory velocity per unit peculiar acceleration, s.
 *
 *   v = 2 f g / (3 Ωm(z) H(z))
 *
 * is the growing-mode solution: linear velocity and peculiar acceleration are
 * parallel, with this ratio, because 4πGρ̄_m = (3/2) Ωm H². For the void alone
 * it reduces to `radialVelocityKms(r, p, { linear: true })` exactly
 * (−(1/3) f a H r Δ either way), which the test asserts.
 * Multiply an m/s² acceleration by this and divide by 1000 for km/s.
 */
export function velocityPerAcceleration(z = 0, cosmo = COSMOLOGY) {
    return 2 * growthRate(z, cosmo) / (3 * omegaMatterAt(z, cosmo) * hubbleSI(z, cosmo));
}

/**
 * T-web class from tidal eigenvalues: the number of eigenvalues above the
 * threshold. 0 = void (expanding in all three directions), 1 = sheet,
 * 2 = filament, 3 = knot (collapsing in all three).
 */
export function twebClass(eigenvalues, threshold = DEFAULT_TWEB_THRESHOLD) {
    const n = eigenvalues.reduce((s, l) => s + (l > threshold ? 1 : 0), 0);
    return { count: n, name: TWEB_CLASSES[n], threshold };
}

// ── Grouping the web's particles into named structures ──────────────────────

const groupCache = new WeakMap();

/**
 * Group the web's particles by the structure they belong to: one group per
 * model node (the node's own particle) and one per filament (its chain).
 *
 * Node particles share their `offsetMpc` ARRAY with the node they came from
 * (js/bootes-web-model.js pushes `node.offsetMpc` by reference), so identity
 * is the join — no tolerance, no nearest-match guess. Any particle that joins
 * nothing lands in an 'other' group rather than being dropped; the test
 * asserts the groups partition the particle set exactly.
 */
export function webStructures(web) {
    const cached = groupCache.get(web);
    if (cached) return cached;
    const byOffset = new Map(web.nodes.map(n => [n.offsetMpc, n]));
    const groups = new Map();
    const groupFor = (key, make) => {
        if (!groups.has(key)) groups.set(key, { ...make(), particles: [], massMsun: 0 });
        return groups.get(key);
    };
    web.particles.forEach((p, i) => {
        let g;
        if (p.kind === 'node' && byOffset.has(p.offsetMpc)) {
            const n = byOffset.get(p.offsetMpc);
            g = groupFor(`node:${n.index}`, () => ({
                id: `node:${n.index}`, kind: 'node', index: n.index,
                anchorId: n.anchorId, positionMpc: n.offsetMpc,
            }));
        } else if (p.kind === 'filament' && p.filament) {
            const f = p.filament;
            g = groupFor(`fil:${f.a}-${f.b}`, () => ({
                id: `fil:${f.a}-${f.b}`, kind: 'filament', a: f.a, b: f.b,
                positionMpc: f.midpointMpc, lengthMpc: f.lengthMpc,
            }));
        } else {
            g = groupFor('other', () => ({ id: 'other', kind: 'other', positionMpc: [0, 0, 0] }));
        }
        g.particles.push(i);
        g.massMsun += p.massMsun;
    });
    const list = [...groups.values()];
    groupCache.set(web, list);
    return list;
}

// ── The web's own fields, evaluated particle by particle ────────────────────

/**
 * Softened point-mass gravity, inlined from `pointGravityVector` so one pass
 * over the particles gives the total, the per-structure split, the tidal
 * tensor and the potential together. It is the SAME expression — including
 * the (1+z)² that was once missing — and the test asserts the inlined total
 * equals `web.externalGravityAt` to 1e-12, so the two cannot drift.
 */
function webFieldsAt(offset, web, z, cosmo) {
    const eps2 = web.softeningMpc * web.softeningMpc;
    const zf = 1 + z;
    const gm = G_SI * MSUN_KG / (MPC_M * MPC_M) * zf * zf;      // × M/d² → m/s²
    const phiK = G_SI * MSUN_KG / MPC_M * zf;                    // × M/d  → m²/s²
    const tidK = 1 / (4 * Math.PI * meanRho(cosmo));             // × M/d³ → 4πGρ̄ units
    const n = web.particles.length;
    const perParticle = new Float64Array(n * 3);
    let gx = 0, gy = 0, gz = 0, phi = 0;
    const T = new Array(9).fill(0);
    for (let i = 0; i < n; i++) {
        const p = web.particles[i];
        const dx = p.offsetMpc[0] - offset[0];
        const dy = p.offsetMpc[1] - offset[1];
        const dz = p.offsetMpc[2] - offset[2];
        const d2 = dx * dx + dy * dy + dz * dz + eps2;
        const d = Math.sqrt(d2);
        const g = gm * p.massMsun / d2;
        const ax = g * dx / d, ay = g * dy / d, az = g * dz / d;
        perParticle[i * 3] = ax; perParticle[i * 3 + 1] = ay; perParticle[i * 3 + 2] = az;
        gx += ax; gy += ay; gz += az;
        phi -= phiK * p.massMsun / d;
        const amp = tidK * p.massMsun / (d2 * d);
        const nx = dx / d, ny = dy / d, nz = dz / d;
        T[0] += amp * (1 - 3 * nx * nx); T[1] += amp * (-3 * nx * ny); T[2] += amp * (-3 * nx * nz);
        T[3] += amp * (-3 * ny * nx); T[4] += amp * (1 - 3 * ny * ny); T[5] += amp * (-3 * ny * nz);
        T[6] += amp * (-3 * nz * nx); T[7] += amp * (-3 * nz * ny); T[8] += amp * (1 - 3 * nz * nz);
    }
    return { gravity: [gx, gy, gz], potential: phi, tidal: T, perParticle };
}

let rhoCache = null;
function meanRho(cosmo) {
    if (rhoCache && rhoCache.cosmo === cosmo) return rhoCache.value;
    // Same expression as meanMatterDensityMsunMpc3, kept local to avoid a
    // per-particle function call; the tidal identity test pins it.
    const h0 = cosmo.H0_kms_Mpc * 1000 / MPC_M;
    const rhoSI = 3 * h0 * h0 / (8 * Math.PI * G_SI);
    const value = cosmo.omegaM * rhoSI * Math.pow(MPC_M, 3) / MSUN_KG;
    rhoCache = { cosmo, value };
    return value;
}

const splitCache = new WeakMap();
function splitOf(voidProfile) {
    let s = splitCache.get(voidProfile);
    if (!s) { s = splitProfile(voidProfile); splitCache.set(voidProfile, s); }
    return s;
}

// ── The probe ───────────────────────────────────────────────────────────────

/**
 * Evaluate everything at one point.
 *
 *   offset        comoving Mpc FROM THE VOID CENTRE (the scene frame)
 *   voidProfile   the full profile (the probe splits it itself)
 *   web           a web from createCosmicWeb, built at the same z
 *   anchors       optional — resolvedAnchors(), used only to NAME the
 *                 direction a model node was drawn towards
 *   topN          how many contributors to return
 *   twebThreshold λ_th for the T-web class
 */
export function probeAt(offset, {
    voidProfile, web, z = 0, cosmo = COSMOLOGY,
    anchors = [], topN = 6, twebThreshold = DEFAULT_TWEB_THRESHOLD,
} = {}) {
    if (!voidProfile || !web) throw new Error('probeAt: voidProfile and web are required');
    if (Math.abs((web.z ?? 0) - z) > 1e-12) {
        // The (1+z)² bias in pointGravityVector got in once because two halves
        // of a comparison were evaluated at different redshifts. Refuse it.
        throw new Error(`probeAt: web was built at z=${web.z}, probe asked for z=${z}`);
    }
    const { deficit, wall } = splitOf(voidProfile);
    const rMpc = norm3(offset);
    const radialUnit = rMpc > 1e-9 ? scale3(offset, 1 / rMpc) : null;
    const origin = [0, 0, 0];

    // ── forces ──
    const gVoid = voidGravityVector(offset, origin, deficit, { z, cosmo });
    const gWall = voidGravityVector(offset, origin, wall, { z, cosmo });
    const wf = webFieldsAt(offset, web, z, cosmo);
    const gWeb = wf.gravity;
    const gA = add3(gVoid, gWeb);
    const gSmooth = add3(gVoid, gWall);
    const gClump = sub3(gWeb, gWall);

    const forces = {
        void: radialSplit(gVoid, radialUnit),
        wall: radialSplit(gWall, radialUnit),
        web: radialSplit(gWeb, radialUnit),
        A: radialSplit(gA, radialUnit),
        B: radialSplit(gWeb, radialUnit),
        smooth: radialSplit(gSmooth, radialUnit),
        clumping: radialSplit(gClump, radialUnit),
    };
    const magVoid = forces.void.magnitude;
    const magWeb = forces.web.magnitude;
    // The same definition `counterfactualAt` uses for the shell statistics, so
    // the probe at a shell point and Test 4's share agree by construction.
    const voidShare = (magVoid + magWeb) > 0 ? magVoid / (magVoid + magWeb) : 0;

    // ── who pulls ──
    const webMag2 = dot3(gWeb, gWeb);
    const anchorName = new Map(anchors.map(a => [a.id, a.name]));
    const structures = webStructures(web).map(s => {
        let x = 0, y = 0, zz = 0;
        for (const i of s.particles) {
            x += wf.perParticle[i * 3]; y += wf.perParticle[i * 3 + 1]; zz += wf.perParticle[i * 3 + 2];
        }
        const vector = [x, y, zz];
        const toward = sub3(s.positionMpc, offset);
        return {
            id: s.id, kind: s.kind, index: s.index, a: s.a, b: s.b,
            anchorId: s.anchorId ?? null,
            anchorName: s.anchorId ? (anchorName.get(s.anchorId) ?? s.anchorId) : null,
            positionMpc: s.positionMpc,
            distanceMpc: norm3(toward),
            massMsun: s.massMsun,
            vector,
            magnitude: norm3(vector),
            // Projected share: Σ shares = 1 exactly (it is Σ g_i·ĝ / |g|).
            share: webMag2 > 0 ? dot3(vector, gWeb) / webMag2 : 0,
        };
    });
    const ranked = [...structures].sort((p, q) => q.magnitude - p.magnitude);
    const top = ranked.slice(0, topN);

    // ── velocity ──
    const vk = velocityPerAcceleration(z, cosmo) / 1000;          // (m/s²) → km/s
    const velocity = {
        A: radialSplit(scale3(gA, vk), radialUnit),
        void: radialSplit(scale3(gVoid, vk), radialUnit),
        web: radialSplit(scale3(gWeb, vk), radialUnit),
        linear: true,
    };

    // ── tidal ──
    const tVoid = voidTidalTensor(offset, origin, deficit);
    const tWall = voidTidalTensor(offset, origin, wall);
    const tA = tVoid.map((v, i) => v + wf.tidal[i]);
    const eigen = symmetricEigen(tA);
    const unit = fourPiGRhoM(z, cosmo);
    const rodPhysM = TIDAL_ROD_MPC * MPC_M / (1 + z);
    const axes = eigen.values.map((lambda, i) => ({
        lambda,
        vector: eigen.vectors[i],
        // Relative acceleration of the two ends of a rod laid along this axis:
        // Δg = −λ·4πGρ̄·L. Positive λ ⇒ the ends close (squeeze).
        rodKmsPerGyr: toKmsPerGyr(-lambda * unit * rodPhysM),
        sense: lambda > 0 ? 'squeeze' : 'stretch',
        // How radial is this axis? |cos| against the void-centre direction.
        radialCos: radialUnit ? Math.abs(dot3(eigen.vectors[i], radialUnit)) : null,
    }));
    const tidal = {
        tensor: tA,
        voidTensor: tVoid,
        smoothWallTensor: tWall,
        webTensor: wf.tidal,
        trace: tA[0] + tA[4] + tA[8],
        axes,
        tweb: twebClass(eigen.values, twebThreshold),
        // Same classifier, on the SMOOTH spherical model, so the page can show
        // what clumping did to the label at this point.
        twebSmooth: twebClass(symmetricEigen(tVoid.map((v, i) => v + tWall[i])).values, twebThreshold),
    };

    // ── potential ── Φ = 0 at infinity for both halves; km²/s².
    const phiVoid = deficit.potentialAt(rMpc, z) / 1e6;
    const phiWall = wall.potentialAt(rMpc, z) / 1e6;
    const phiWeb = wf.potential / 1e6;
    const potential = {
        void: phiVoid, wall: phiWall, web: phiWeb,
        A: phiVoid + phiWeb, smooth: phiVoid + phiWall,
    };

    // Local density contrast of the smooth profile, for context.
    const deltaLocal = voidProfile.deltaAt(rMpc);

    // LIVE IDENTITY RESIDUALS, printed under the probe readout. The test gate
    // asserts these at fixed points; computing them at the reader's point too
    // means the page shows the bookkeeping holding wherever they put the probe,
    // instead of asking them to take a node test's word for it.
    const sumC = structures.reduce((acc, c) => add3(acc, c.vector), [0, 0, 0]);
    const checks = {
        // Σ structures − web, relative.
        contributors: norm3(sub3(sumC, gWeb)) / Math.max(norm3(gWeb), 1e-300),
        // tr(T_void + T_smoothWall) − δ(r): Poisson for the spherical part.
        trace: Math.abs(tVoid[0] + tVoid[4] + tVoid[8] + tWall[0] + tWall[4] + tWall[8] - deltaLocal),
        // Σ projected shares − 1.
        shares: Math.abs(structures.reduce((acc, c) => acc + c.share, 0) - 1),
    };

    return {
        positionMpc: [...offset],
        rMpc,
        radialUnit,
        z,
        forces,
        voidShare,
        contributors: { top, all: structures, count: structures.length },
        velocity,
        tidal,
        potential,
        deltaLocal,
        softeningMpc: web.softeningMpc,
        checks,
    };
}

/**
 * The total peculiar acceleration field (model A, or B / the void alone) as a
 * closure, for streamlines. Bound once to one profile, one web and one z so the
 * void and web halves cannot be evaluated at different redshifts.
 */
export function accelerationField({ voidProfile, web, z = 0, cosmo = COSMOLOGY, which = 'A' }) {
    const { deficit } = splitOf(voidProfile);
    const origin = [0, 0, 0];
    if (which === 'void') return (p) => voidGravityVector(p, origin, deficit, { z, cosmo });
    if (which === 'B') return (p) => web.externalGravityAt(p);
    return (p) => add3(voidGravityVector(p, origin, deficit, { z, cosmo }), web.externalGravityAt(p));
}

// ── Sweeps ──────────────────────────────────────────────────────────────────

/**
 * The force components along the ray from the void centre through `direction`,
 * radial part only (positive = away from the centre). This is the probe's own
 * radial chart: the page's Test 4 chart is a direction-MEDIAN, this is the one
 * direction the reader chose, so the two can be compared.
 */
export function radialSweep(direction, {
    voidProfile, web, z = 0, cosmo = COSMOLOGY, rMaxMpc, samples = 90,
} = {}) {
    const n = norm3(direction);
    if (!(n > 0)) throw new Error('radialSweep: direction must be non-zero');
    const u = scale3(direction, 1 / n);
    const { deficit, wall } = splitOf(voidProfile);
    const out = [];
    for (let i = 0; i <= samples; i++) {
        const r = Math.max(0.5, rMaxMpc * i / samples);
        const p = scale3(u, r);
        const gv = voidGravityVector(p, [0, 0, 0], deficit, { z, cosmo });
        const gw = web.externalGravityAt(p);
        const gs = voidGravityVector(p, [0, 0, 0], wall, { z, cosmo });
        out.push({
            radiusMpc: r,
            void: toKmsPerGyr(dot3(gv, u)),
            web: toKmsPerGyr(dot3(gw, u)),
            wall: toKmsPerGyr(dot3(gs, u)),
            A: toKmsPerGyr(dot3(add3(gv, gw), u)),
            magA: toKmsPerGyr(norm3(add3(gv, gw))),
        });
    }
    return out;
}

/**
 * Trace a streamline of a vector field through `start`, both ways.
 *
 * Midpoint (RK2) steps of fixed LENGTH along the normalised field, so the
 * curve's sampling does not collapse where the field is weak. Stops on:
 *   'sink'     the direction reverses (|Δθ| > 120° in one step) — the curve has
 *              arrived at a convergence point, typically a model node
 *   'weak'     |field| below `minMagnitude`
 *   'range'    left the modelled sphere
 *   'steps'    hit maxSteps
 *
 * `fieldAt(p) → [x,y,z]` is any field; the page passes the total peculiar
 * acceleration (∝ the linear velocity, so the streamline is the same curve).
 */
export function traceStreamline(start, fieldAt, {
    stepMpc = 3, maxSteps = 160, rMaxMpc = Infinity, minMagnitude = 0,
} = {}) {
    const walk = (sign) => {
        const pts = [[...start]];
        let p = [...start];
        let prevDir = null;
        let reason = 'steps';
        for (let i = 0; i < maxSteps; i++) {
            const f0 = fieldAt(p);
            const m0 = norm3(f0);
            if (!(m0 > minMagnitude)) { reason = 'weak'; break; }
            const d0 = scale3(f0, sign / m0);
            const mid = add3(p, scale3(d0, stepMpc / 2));
            const f1 = fieldAt(mid);
            const m1 = norm3(f1);
            if (!(m1 > minMagnitude)) { reason = 'weak'; break; }
            const d1 = scale3(f1, sign / m1);
            if (prevDir && dot3(prevDir, d1) < -0.5) { reason = 'sink'; break; }
            p = add3(p, scale3(d1, stepMpc));
            prevDir = d1;
            if (norm3(p) > rMaxMpc) { reason = 'range'; pts.push(p); break; }
            pts.push(p);
        }
        return { points: pts, reason };
    };
    const forward = walk(+1);
    const backward = walk(-1);
    return { forward, backward };
}
