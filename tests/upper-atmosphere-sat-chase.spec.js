/**
 * upper-atmosphere-sat-chase.spec.js — zooming in to one spacecraft
 * ═══════════════════════════════════════════════════════════════════════════
 * Hermetic: the synthetic catalogue (tests/fixtures/sat-suites-synthetic.mjs)
 * on the manual frame clock, the bus stepped by hand. Pins (plan §9.17):
 *   • THE CAMERA TRACKS EXACTLY: with the bus advancing a second per frame
 *     the ISS moves ~7.7 km/frame and the eye-to-target distance equals the
 *     chase's own `dist` to 1e-9 on every frame — NEGATIVE CONTROL: the
 *     legacy eased follow (no chase) lags the same target by far more;
 *   • the chase eases to CHASE.defaultR from wherever the camera was; the
 *     wheel zooms it on the log ladder (three notches = ÷1.18³); the probe
 *     model's scale is the kernel's `modelScale` at that range and the near
 *     plane tightens under the range;
 *   • a drag orbits the camera about the target (az moves, range does not);
 *   • a CATALOGUE dot is followable: its avatar stands on the dot (model
 *     family from the name), scaled, the tracker's highlight labels it, the
 *     follow card names it with the symbolic-scale disclosure; Esc releases
 *     and the avatar, highlight and card go;
 *   • while chasing, the projection's principal point sits in the clear
 *     part of the stage (the kernel's safe centre), and clears on release;
 *   • ATTITUDE, SUN AND GROUND (plan §9.18/§9.19): the avatar's quaternion
 *     is the kernel's nominal basis for its family, its array pivots sit at
 *     the kernel's alpha, the key light's intensity is the kernel's
 *     illumination fraction — NEGATIVE CONTROL: the sun vector held
 *     opposite flips the state and the light follows — the ground track's
 *     lines lie on the surface sphere with the marker under the target, and
 *     the card prints the mode, β and the sub-satellite point;
 *   • LIGHTING PHASES 2 + 3 (plan §9.19): the key light casts a shadow map
 *     scoped to the followed hull (the shadow camera's extent follows the
 *     model scale) and a MEASURED self-shadow — with the Sun along the wing
 *     axis the wing shades the bus, the pixel sum under the target is lower
 *     with the shadow pass on than off; a flare: with the Sun staged at the
 *     camera's body direction mirrored in X (kernel trackingArrayFlareSun)
 *     the tracked wing throws the Sun into the camera, the glint reads > 0.9
 *     and its sprite is up — NEGATIVE CONTROL: the Sun at the camera's own
 *     direction gives no flare;
 *   • LIGHTING PHASES 4 + 5 (plan §9.19): in close-up the models' reflection
 *     environment is a cube render of the PLANET from the followed object
 *     (the model materials' envMap is the PMREM of that render, refreshed
 *     on the kernel's cadence and held between) — MEASURED on the faces
 *     read back: with the Sun along the target's radial the planet half of
 *     the environment is lit, with it opposite the same faces are dark
 *     (the negative control); the renderer's filmic curve is ON only in the
 *     chase (ACES, exposure at the kernel's base when sunlit, lifted toward
 *     eclipseGain in umbra — MEASURED: the frame is brighter with the lift
 *     than with it disabled, the control), every non-lit material in the
 *     scene is exempt (the skin's `toneMapped` is false; the census finds no
 *     tone-mapped material without the lit flag), the card discloses both,
 *     and release restores NoToneMapping and the procedural environment;
 *   • the altitude tour: "higher" from the ISS lands on the next object up
 *     by page altitude and the flight is an ARC (lifted, never inside the
 *     planet) — NEGATIVE CONTROL: the straight chord between the two eyes
 *     passes below the lower end.
 */

import { test, expect } from '@playwright/test';
import { routeSyntheticCatalogue } from './fixtures/sat-suites-synthetic.mjs';

const URL = '/upper-atmosphere.html';
const DT = 1 / 60;
const EPOCH = Math.floor(Date.now() / 3600e3) * 3600e3 - 3600e3;
test.describe.configure({ timeout: 240_000 });

async function boot(page) {
    await page.route('**/api/donki/**', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
    await routeSyntheticCatalogue(page, EPOCH);
    await page.goto(URL);
    await page.waitForFunction(() => !!window.__ua?.globe?.stepFrames && !!window.__ua?.satSuites && !!window.__ua?.followCard, null, { timeout: 60_000 });
    const consent = page.locator('.pp-consent-banner');
    await consent.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
    if (await consent.isVisible().catch(() => false)) await consent.locator('[data-action="reject"]').click().catch(() => {});
    await page.waitForTimeout(600);
    await page.locator('#ua-aside-tabs [data-ua-tab="analysis"]').click();
    await page.evaluate((EPOCH) => {
        const g = window.__ua.globe;
        g.setBeaconsVisible?.(false);
        g.setManualClock(true, { startMs: 1e6 });
        const b = g._timeBus; b.pause(); b.setSimTime(EPOCH + 3600e3);
        g.stepFrames(3, 1 / 60, { render: 'none' });
    }, EPOCH);
}
const step = (page, n) => page.evaluate(([n, dt]) => window.__ua.globe.stepFrames(n, dt, { render: 'none' }), [n, DT]);
/** Advance the bus by `ms` per frame for n frames; returns the worst |eye−target| − dist. */
const stepMoving = (page, n, ms, targetSel = 'iss') => page.evaluate(([n, dt, ms, sel]) => {
    const g = window.__ua.globe, c = g._controls, b = g._timeBus;
    const tgt = () => sel === 'iss' ? g._satProbes.iss.mesh.position : g._catFollow.pos;
    let worst = 0, moved = 0;
    for (let i = 0; i < n; i++) {
        const before = tgt().clone();
        b.setSimTime(b.getSimTime() + ms);
        g.stepFrames(1, dt, { render: 'none' });
        moved = Math.max(moved, tgt().distanceTo(before));
        const st = c.getFollowState();
        if (st) worst = Math.max(worst, Math.abs(g._camera.position.distanceTo(tgt()) - st.dist));
    }
    return { worst, movedKm: moved * 6371 };
}, [n, DT, ms, targetSel]);
async function enableSuite(page, group) {
    await page.locator(`#ua-sat-suites label[data-group="${group}"]`).click();
    await page.waitForFunction((g) => (window.__ua.globe.getCatalogStatus().groups.find((x) => x.name === g)?.count ?? 0) > 0, group, { timeout: 30_000 });
    // The worker publishes positions asynchronously; a slot reads (0,0,0) until then.
    for (let i = 0; i < 60; i++) {
        const ok = await page.evaluate(([dt]) => { const g = window.__ua.globe; g.stepFrames(1, dt, { render: 'none' }); const p = g._catalogTracker.getPositionXYZ(70003); return !!p && Math.hypot(p.x, p.y, p.z) > 0.9; }, [DT]);
        if (ok) return;
        await page.waitForTimeout(100);
    }
    throw new Error('catalogue positions never published');
}

test('the chase tracks a moving target exactly, eases to range, zooms on the ladder, orbits on drag', async ({ page }) => {
    await boot(page);
    const K = await page.evaluate(async () => { const m = await import('./js/upper-atmosphere-sat-view.js'); return { defaultR: m.CHASE.defaultR, notch: m.CHASE.zoomNotch, refR: m.MODEL_REF_R, sens: m.CHASE.dragSens }; });
    await page.evaluate(() => window.__ua.globe.followSatellite('iss'));
    await step(page, 90);
    const st0 = await page.evaluate(() => window.__ua.globe._controls.getFollowState());
    expect(Math.abs(st0.dist - K.defaultR) / K.defaultR, 'eased to the default range').toBeLessThan(0.01);

    // Moving target: a second of bus time per frame (~7.7 km), exact to 1e-9.
    const mv = await stepMoving(page, 40, 1000);
    expect(mv.movedKm).toBeGreaterThan(5);
    expect(mv.worst).toBeLessThan(1e-9);
    // NEGATIVE CONTROL: the legacy eased follow (no chase) lags by far more.
    const lag = await page.evaluate(([dt]) => {
        const g = window.__ua.globe, c = g._controls, b = g._timeBus, probe = g._satProbes.iss;
        c.followObject(() => probe.mesh.position, { smoothing: 0.15 });
        let worst = 0;
        for (let i = 0; i < 20; i++) { b.setSimTime(b.getSimTime() + 1000); g.stepFrames(1, dt, { render: 'none' }); worst = Math.max(worst, Math.abs(g._camera.position.distanceTo(probe.mesh.position) - 0.18)); }
        return worst;
    }, [DT]);
    expect(lag).toBeGreaterThan(1e-4);
    await page.evaluate(() => window.__ua.globe.followSatellite('iss'));
    await step(page, 120);

    // Wheel: three notches in → ÷ notch³; model scale and near plane follow.
    await page.evaluate(() => { for (let i = 0; i < 3; i++) window.__ua.globe.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true })); });
    await step(page, 150);
    const z = await page.evaluate(() => { const g = window.__ua.globe; const st = g._controls.getFollowState(); return { dist: st.dist, distT: st.distT, mid: g._satProbes.iss.midGrp.scale.x, nearGrp: g._satProbes.iss.nearGrp.scale.x, near: g._camera.near }; });
    expect(Math.abs(z.distT - K.defaultR / K.notch ** 3)).toBeLessThan(1e-9);
    expect(Math.abs(z.dist - z.distT) / z.distT).toBeLessThan(0.01);
    expect(Math.abs(z.mid - z.dist / K.refR)).toBeLessThan(0.02);
    expect(z.nearGrp).toBeCloseTo(z.mid, 6);
    expect(z.near).toBeLessThan(z.dist);
    expect(z.near).toBeLessThan(0.21 * z.dist + 1e-9);

    // PHASE 2, MEASURED: with the Sun along the ISS's radial the upper arrays
    // shade the pair below them and the truss — the frame is darker with the
    // shadow pass on than with it off (the whole frame: from above and
    // behind, the shaded lower arrays are partly under the upper ones, and a
    // block around the target missed them — measured, the sums were equal).
    const sh = await page.evaluate(([dt]) => {
        const g = window.__ua.globe, probe = g._satProbes.iss, cam = g._camera;
        g.setSunDirOverride(probe.mesh.position.clone().normalize());
        g.stepFrames(3, dt, { render: 'none' });
        const W = g.canvas.width, H = g.canvas.height, gl = g._renderer.getContext();
        const block = () => { const buf = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf); let sum = 0; for (let i = 0; i < buf.length; i += 4) sum += buf[i] + buf[i + 1] + buf[i + 2]; return sum; };
        g._renderer.render(g._scene, cam); const withShadow = block();
        const cast = g._sunLight.castShadow;
        g._sunLight.castShadow = false; g._renderer.render(g._scene, cam); const without = block();
        g._sunLight.castShadow = cast;
        g.setSunDirOverride(null); g.stepFrames(2, dt, { render: 'none' });
        return { withShadow, without, cast, lit: g.getFollowInfo()?.sun?.state };
    }, [DT]);
    expect(sh.cast).toBe(true);
    expect(sh.without - sh.withShadow, 'the shadow darkens the hull').toBeGreaterThan(0);

    // PHASE 4 — the environment is the planet, rendered from the target.
    const env = await page.evaluate(([dt]) => {
        const g = window.__ua.globe, probe = g._satProbes.iss;
        const radial = probe.mesh.position.clone().normalize();
        // The skin's aurora is part of the environment too (a high-latitude
        // target over the night-side oval reads 2.8 vs 0.46 on the nadir
        // faces — measured), so the day-vs-night comparison holds it OFF for
        // both readings and measures the surface alone.
        const au = g._skin.earthU.u_aurora_on, auroraWas = au.value; au.value = 0;
        g.setSunDirOverride(radial); g.stepFrames(3, dt, { render: 'none' });
        const t0 = performance.now(); const forced = g.refreshEnvironment(); const ms = performance.now() - t0;
        const lit = g._envFaceMeans(), stLit = g.getEnvironmentState();
        let mat = null; (probe.nearGrp.visible ? probe.nearGrp : probe.midGrp).traverse((o) => { if (!mat && o.isMesh && o.material?.envMap) mat = o.material; });
        const envIsPlanet = !!mat && mat.envMap === g._envPmremTarget?.texture;
        g.setSunDirOverride(radial.clone().negate()); g.stepFrames(3, dt, { render: 'none' }); g.refreshEnvironment();
        const dark = g._envFaceMeans();
        // The cadence: after the interval a RENDERED frame refreshes (and says why); the next one holds.
        g.stepFrames(Math.ceil(4.1 / dt), dt, { render: 'none' });
        const n0 = g.getEnvironmentState().renders;
        g.stepFrames(1, dt, { render: 'last' }); const bumped = g.getEnvironmentState();
        g.stepFrames(1, dt, { render: 'last' }); const held = g.getEnvironmentState();
        au.value = auroraWas;
        g.setSunDirOverride(null); g.stepFrames(2, dt, { render: 'none' });
        return { forced, ms, lit, dark, stLit, envIsPlanet, cadence: { bumped: bumped.renders === n0 + 1, why: bumped.why, held: held.renders === n0 + 1 } };
    }, [DT]);
    expect(env.forced).toBe(true);
    expect(env.stLit.mode).toBe('planet');
    expect(env.envIsPlanet, 'the model materials reflect the planet render').toBe(true);
    expect(Math.max(...env.lit), 'a lit planet in the environment').toBeGreaterThan(2);
    expect(Math.max(...env.lit), 'sunlit under the target vs night under it (control)').toBeGreaterThan(3 * Math.max(...env.dark));
    expect(env.cadence).toEqual({ bumped: true, why: 'interval', held: true });
    expect(env.ms).toBeLessThan(2000);

    // PHASE 5 — the filmic curve for the lit hull only, with the eclipse lift.
    const ex = await page.evaluate(async ([dt]) => {
        const THREE = await import('three'); const V = await import('./js/upper-atmosphere-sat-view.js');
        const g = window.__ua.globe, r = g._renderer, probe = g._satProbes.iss, cam = g._camera;
        const radial = probe.mesh.position.clone().normalize();
        // Only the lit materials pass through the curve, so the pixels that
        // DIFFER between the lifted frame and the control frame are the hull:
        // measure the hull's own level, not its share of the frame (a whole-
        // frame sum moved 1.9 % at one framing and 0.14 % at another).
        const grab = () => { const W = g.canvas.width, H = g.canvas.height, gl = r.getContext(); const buf = new Uint8Array(W * H * 4); r.render(g._scene, cam); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf); return buf; };
        // (the volume march jitters by a level or two between renders, so a
        // pixel counts as the hull only past that: |Δ| > 9 of 765)
        const hullLevels = (a, b) => { let n = 0, sa = 0, sb = 0, any = 0; for (let i = 0; i < a.length; i += 4) { const la = a[i] + a[i + 1] + a[i + 2], lb = b[i] + b[i + 1] + b[i + 2]; if (la !== lb) any++; if (Math.abs(la - lb) > 9) { n++; sa += la; sb += lb; } } return { px: n, any, a: n ? sa / n : 0, b: n ? sb / n : 0 }; };
        g.setSunDirOverride(radial); g.stepFrames(300, dt, { render: 'none' });
        const lit = { tm: r.toneMapping, exp: r.toneMappingExposure, rs: g.getRenderState() };
        let litN = 0, bad = []; g._scene.traverse((o) => { const m = o.material; if (!m) return; for (const mat of Array.isArray(m) ? m : [m]) { if (mat.userData?.lit) litN++; else if (mat.toneMapped !== false) bad.push(o.name || o.type); } });
        const skin = g._skin.earthMesh.material.toneMapped;
        g.setSunDirOverride(radial.clone().negate()); g.stepFrames(300, dt, { render: 'none' });
        window.__ua.followCard.refresh();
        const card = document.getElementById('ua-follow-card').textContent;
        const dark = { exp: r.toneMappingExposure, rs: g.getRenderState(), state: g.getFollowInfo().sun.state };
        const liftedFrame = grab();
        g.setExposureLift(false); g.stepFrames(300, dt, { render: 'none' });   // CONTROL: no lift
        const ctrl = { exp: r.toneMappingExposure };
        const hull = hullLevels(liftedFrame, grab());
        g.setExposureLift(true); g.setSunDirOverride(null); g.stepFrames(2, dt, { render: 'none' });
        return { ACES: THREE.ACESFilmicToneMapping, K: V.EXPOSURE, lit, dark, ctrl, hull, census: { litN, bad: bad.slice(0, 5) }, skin, card };
    }, [DT]);
    expect(ex.lit.tm).toBe(ex.ACES);
    expect(Math.abs(ex.lit.exp - ex.K.base)).toBeLessThan(0.02);
    expect(ex.lit.rs.lift).toBe(1);
    expect(ex.census.litN).toBeGreaterThan(0);
    expect(ex.census.bad, 'no tone-mapped material without the lit flag').toEqual([]);
    expect(ex.skin, 'the planet skin never passes through the curve').toBe(false);
    expect(ex.dark.state).toBe('umbra');
    expect(Math.abs(ex.dark.rs.lift - ex.K.eclipseGain)).toBeLessThan(1e-9);
    expect(Math.abs(ex.dark.exp - ex.K.base * ex.K.eclipseGain)).toBeLessThan(0.05);
    expect(Math.abs(ex.ctrl.exp - ex.K.base)).toBeLessThan(0.02);
    expect(ex.hull.px, 'the hull is on screen').toBeGreaterThan(100);
    // A ×2.6 lift on an earthshine-lit mid-grey hull reads ~1.25 in DISPLAY
    // levels: the filmic shoulder and the sRGB encode both compress it
    // (0.55 → 0.87 linear is 0.76 → 0.94 encoded). Measured 1.27–1.28; the
    // control (lift off) is 1.00 by construction.
    expect(ex.hull.a / Math.max(1, ex.hull.b), 'the lift brightens the eclipsed hull (control: lift off)').toBeGreaterThan(1.15);
    expect(ex.card).toContain('reflections: live planet');
    expect(ex.card).toContain('exposure ×');

    // Drag: az moves by dx·sens (eased), the range does not.
    const r = await page.locator('#ua-globe').boundingBox();
    const cx = r.x + r.width * 0.3, cy = r.y + r.height * 0.5;
    await page.mouse.move(cx, cy); await page.mouse.down();
    await page.mouse.move(cx + 120, cy, { steps: 6 });
    await page.mouse.up();
    await step(page, 120);
    const d = await page.evaluate(() => window.__ua.globe._controls.getFollowState());
    const expectAz = ((Math.PI - 120 * K.sens + Math.PI) % (2 * Math.PI)) - Math.PI;
    expect(Math.abs(Math.atan2(Math.sin(d.az - expectAz), Math.cos(d.az - expectAz)))).toBeLessThan(0.02);
    expect(Math.abs(d.dist - z.dist) / z.dist).toBeLessThan(0.01);
});

test('a catalogue dot is followable: avatar, highlight, card and disclosure; Esc releases; the safe frame', async ({ page }) => {
    await boot(page);
    await enableSuite(page, 'starlink');
    const ok = await page.evaluate(() => window.__ua.globe.flyToCatalog(70003, 0.5, { follow: true }));
    expect(ok).toBe(true);
    await step(page, 40);                 // the flight (frame clock)
    await page.waitForTimeout(800);       // the hand-off timer (wall clock)
    await step(page, 120);
    const mv = await stepMoving(page, 30, 500, 'cat');
    expect(mv.worst).toBeLessThan(1e-9);
    const s = await page.evaluate(async () => {
        const g = window.__ua.globe; const m = await import('./js/upper-atmosphere-sat-view.js');
        window.__ua.followCard.refresh();
        const st = g._controls.getFollowState();
        const card = document.getElementById('ua-follow-card');
        return {
            following: g.isFollowing(), target: g.getFollowTarget(), info: g.getFollowInfo(),
            avatarVisible: g._avatar?.grp.visible, family: g._avatar?.family,
            avatarScale: g._avatar?.grp.scale.x, expectScale: m.modelScale(st.dist),
            onDot: g._avatar?.grp.position.distanceTo(g._catFollow.pos),
            highlight: g._catalogTracker._highlightNoradId, highlightVisible: g._catalogTracker._highlightSprite?.visible,
            cardHidden: card.hidden, cardText: card.textContent.replace(/\s+/g, ' '),
            safe: g.getChaseSafeFrame(), view: g._camera.view ? { ox: g._camera.view.offsetX, oy: g._camera.view.offsetY, on: g._camera.view.enabled } : null,
            camDock: document.getElementById('ua-camera-hud').getBoundingClientRect().left - g.canvas.getBoundingClientRect().left,
        };
    });
    expect(s.following).toBe(true);
    expect(s.target).toEqual({ kind: 'catalog', id: 70003 });
    expect(s.info.name).toBe('STARLINK-SYN 0-3');
    expect(s.info.family).toBe('starlink');
    expect(s.family).toBe('starlink');
    expect(s.avatarVisible).toBe(true);
    expect(s.onDot).toBeLessThan(1e-9);
    expect(Math.abs(s.avatarScale - s.expectScale)).toBeLessThan(0.02);
    expect(s.highlight).toBe(70003);
    // Inside the model-hold range the world-sized highlight sprite yields to
    // the avatar (it filled the frame white at 70 km — measured) …
    expect(s.highlightVisible).toBe(false);
    // … and returns once the camera backs off past MODEL_REF_R (8 notches out).
    await page.evaluate(() => { for (let i = 0; i < 8; i++) window.__ua.globe.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true })); });
    await step(page, 150);
    const far = await page.evaluate(async () => { const m = await import('./js/upper-atmosphere-sat-view.js'); const g = window.__ua.globe; return { dist: g._controls.getFollowState().dist, ref: m.MODEL_REF_R, hl: g._catalogTracker._highlightSprite?.visible, scale: g._avatar.grp.scale.x }; });
    expect(far.dist).toBeGreaterThan(far.ref);
    expect(far.hl).toBe(true);
    expect(far.scale).toBe(1);
    await page.evaluate(() => { for (let i = 0; i < 8; i++) window.__ua.globe.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true })); });
    await step(page, 150);
    expect(s.cardHidden).toBe(false);
    expect(s.cardText).toContain('STARLINK-SYN 0-3');
    expect(s.cardText).toMatch(/symbolic model: drawn [\d.,]+ km across/);
    expect(s.cardText).toMatch(/true ≈3 m span/);
    // The safe frame: the principal point sits left of the camera dock, in the clear.
    expect(s.view?.on).toBe(true);
    expect(s.safe.cx).toBeLessThan(s.camDock);
    expect(s.safe.cx).toBeGreaterThan(60);
    expect(s.view.ox).toBe(Math.round(s.safe.W / 2 - s.safe.cx));

    // ATTITUDE / SUN / GROUND on the same catalogue chase.
    const ag = await page.evaluate(async () => {
        const K = await import('./js/upper-atmosphere-sat-attitude.js');
        const THREE = await import('three');
        const g = window.__ua.globe, cf = g._catFollow, av = g._avatar;
        const sd = g._sunDir.toArray();
        const b = K.attitudeBasis({ family: 'starlink', pos: cf.pos.toArray(), vel: cf.vel.toArray(), sunDir: sd, tS: g.getSceneTimeMs() / 1000, id: cf.norad });
        const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...b.x), new THREE.Vector3(...b.y), new THREE.Vector3(...b.z));
        const q = new THREE.Quaternion().setFromRotationMatrix(m);
        const alpha = K.arrayAlpha(K.toBody(sd, b)).alphaRad;
        const ill = K.illumination(cf.pos.toArray(), sd);
        const info = g.getFollowInfo();
        const tr = g.getGroundTrackState();
        const pastPts = (() => { const a = g._track.past.geometry.attributes.position.array, n = tr.past; const out = []; for (let i = 0; i < n; i++) out.push(Math.hypot(a[i * 3], a[i * 3 + 1], a[i * 3 + 2])); return out; })();
        const mk = new THREE.Vector3(...tr.marker).normalize();
        window.__ua.followCard.refresh();
        return {
            qAngle: av.grp.quaternion.angleTo(q), arrays: av.arrays.length, arrayRot: av.arrays.map((w) => w.rotation.x), alpha,
            light: g._sunLight.intensity, lightFull: g._sunLight.intensity / Math.max(1e-9, ill.fraction || 1), fraction: ill.fraction, state: ill.state,
            infoSun: info.sun, infoAtt: info.attitude, infoGround: info.ground,
            track: tr, pastR: [Math.min(...pastPts), Math.max(...pastPts)],
            markerDot: mk.dot(cf.pos.clone().normalize()),
            earthShineDot: g._earthShine.position.clone().normalize().dot(cf.pos.clone().normalize()),
            lit: Object.values(av.grp.children).some((o) => o.material?.isMeshStandardMaterial || o.children?.some((c) => c.material?.isMeshStandardMaterial)),
            card: document.getElementById('ua-follow-card').textContent.replace(/\s+/g, ' '),
        };
    });
    expect(ag.qAngle).toBeLessThan(1e-6);
    expect(ag.arrays).toBeGreaterThan(0);
    for (const r of ag.arrayRot) expect(Math.abs(r - ag.alpha)).toBeLessThan(1e-9);
    expect(ag.infoAtt.modeId).toBe('nadir');
    expect(ag.infoSun.state).toBe(ag.state);
    expect(Math.abs(ag.light - 2.3 * ag.fraction)).toBeLessThan(1e-9);
    expect(ag.track.visible).toBe(true);
    expect(ag.track.past).toBeGreaterThan(50);
    expect(ag.track.future).toBeGreaterThan(100);
    expect(ag.pastR[0]).toBeGreaterThan(1.0015 - 1e-6);   // a Float32Array holds the surface points
    expect(ag.pastR[1]).toBeLessThan(1.0015 + 1e-6);
    expect(ag.markerDot).toBeGreaterThan(1 - 1e-9);
    expect(ag.earthShineDot).toBeGreaterThan(1 - 1e-9);
    expect(ag.lit).toBe(true);
    expect(Number.isFinite(ag.infoSun.betaDeg)).toBe(true);
    expect(ag.infoGround.latDeg).toBeGreaterThan(-90);
    expect(ag.card).toContain('nadir-pointing');
    expect(ag.card).toMatch(/β -?[\d.]+°/);
    expect(ag.card).toMatch(/\d+\.\d+°[NS] \d+\.\d+°[EW]/);
    // NEGATIVE CONTROL: the Sun held along the target's anti-radial puts it
    // exactly behind the planet (umbra, key light off); along its radial, in
    // full sun (light at full). Flipping the Sun through the centre would
    // NOT do: a broadside satellite is sunlit from both sides.
    const flipped = await page.evaluate(async ([dt]) => {
        const g = window.__ua.globe, cf = g._catFollow;
        const was = g.getFollowInfo().sun.state;
        g.setSunDirOverride(cf.pos.clone().normalize().negate());
        g.stepFrames(2, dt, { render: 'none' });
        const dark = { state: g.getFollowInfo().sun.state, light: g._sunLight.intensity };
        g.setSunDirOverride(cf.pos.clone().normalize());
        g.stepFrames(2, dt, { render: 'none' });
        const lit = { state: g.getFollowInfo().sun.state, light: g._sunLight.intensity };
        g.setSunDirOverride(null);
        g.stepFrames(2, dt, { render: 'none' });
        return { was, dark, lit, back: g.getFollowInfo().sun.state };
    }, [DT]);
    expect(flipped.dark).toEqual({ state: 'umbra', light: 0 });
    expect(flipped.lit).toEqual({ state: 'sunlit', light: 2.3 });
    expect(flipped.back).toBe(flipped.was);

    // PHASE 2 — the shadow map is SCOPED to the followed hull (the measured
    // self-shadow is in the ISS test: eight stacked arrays).
    const sh = await page.evaluate(() => {
        const g = window.__ua.globe, av = g._avatar;
        return { enabled: g._renderer.shadowMap.enabled, cast: g._sunLight.castShadow, extent: g._sunLight.shadow.camera.right, scale: av.grp.scale.x,
            meshes: (() => { let n = 0, c = 0; av.grp.traverse((o) => { if (o.isMesh) { n++; if (o.castShadow && o.receiveShadow) c++; } }); return { n, c }; })(),
            lightDist: g._sunLight.position.distanceTo(av.grp.position) };
    });
    expect(sh.enabled).toBe(true);
    expect(sh.cast).toBe(true);
    expect(sh.meshes.n).toBeGreaterThan(0);
    expect(sh.meshes.c).toBe(sh.meshes.n);
    expect(Math.abs(sh.extent - 0.04 * 0.9 * sh.scale) / (0.04 * 0.9 * sh.scale)).toBeLessThan(0.02);   // re-fitted with 1 % hysteresis
    expect(Math.abs(sh.lightDist - 2 * sh.extent) / (2 * sh.extent)).toBeLessThan(0.03);   // 2 extents sunward of the hull

    // PHASE 3 — a staged flare, and its negative control.
    const fl = await page.evaluate(async ([dt]) => {
        const THREE = await import('three');
        const K = await import('./js/upper-atmosphere-sat-attitude.js');
        const g = window.__ua.globe, av = g._avatar, cam = g._camera;
        g._controls.orbitFollowBy(220, 0);                 // off the orbit plane: a mirror in X then matters
        g.stepFrames(150, dt, { render: 'none' });
        const q = av.grp.quaternion.clone();
        const wing = av.arrays[0], wp = new THREE.Vector3(); wing.getWorldPosition(wp);
        const v = cam.position.clone().sub(wp).normalize();
        const vBody = v.clone().applyQuaternion(q.clone().invert());
        const sBody = K.trackingArrayFlareSun([vBody.x, vBody.y, vBody.z]);
        g.setSunDirOverride(new THREE.Vector3(...sBody).applyQuaternion(q));
        g.stepFrames(3, dt, { render: 'none' });
        const en = av.glints.find((e) => e.o === wing);
        const on = { glint: g.getFollowInfo().glint, visible: en.sprite.visible, opacity: en.sprite.material.opacity, scale: en.sprite.scale.x };
        window.__ua.followCard.refresh();
        const card = document.getElementById('ua-follow-card').textContent;
        g.setSunDirOverride(v);                             // CONTROL: the Sun at the camera's own direction
        g.stepFrames(3, dt, { render: 'none' });
        const off = { glint: g.getFollowInfo().glint, visible: en.sprite.visible };
        g.setSunDirOverride(null); g.stepFrames(2, dt, { render: 'none' });
        return { vBodyX: vBody.x, on, off, card };
    }, [DT]);
    expect(Math.abs(fl.vBodyX)).toBeGreaterThan(0.2);
    expect(fl.on.glint.max).toBeGreaterThan(0.9 * 0.6);     // × the array's gain
    expect(fl.on.glint.surface).toBe('array');
    expect(fl.on.visible).toBe(true);
    expect(fl.on.opacity).toBeGreaterThan(0.5);
    expect(fl.on.scale).toBeGreaterThan(0.04);
    expect(fl.card).toContain('flare toward you');
    expect(fl.off.glint.max).toBeLessThan(0.05);
    expect(fl.off.visible).toBe(false);

    // Esc releases: avatar, highlight, card and the view offset all go.
    await page.locator('#ua-globe').hover();
    await page.keyboard.press('Escape');
    await step(page, 3);
    await page.evaluate(() => window.__ua.followCard.refresh());
    const e = await page.evaluate(() => { const g = window.__ua.globe; return { following: g.isFollowing(), avatar: g._avatar?.grp.visible, trail: g._avatar?.trail.visible, highlight: g._catalogTracker._highlightSprite?.visible, card: document.getElementById('ua-follow-card').hidden, view: g._camera.view?.enabled ?? false, safe: g.getChaseSafeFrame(), track: g.getGroundTrackState().visible, light: g._sunLight.intensity }; });
    expect(e).toEqual({ following: false, avatar: false, trail: false, highlight: false, card: true, view: false, safe: null, track: false, light: 2.3 });
    expect(await page.evaluate(() => window.__ua.globe._sunLight.castShadow)).toBe(false);
    // Phases 4–5 release: the curve is off and the procedural environment is back.
    expect(await page.evaluate(() => { const g = window.__ua.globe; return { tm: g._renderer.toneMapping, exp: g._renderer.toneMappingExposure, env: g.getEnvironmentState().mode, rs: g.getRenderState().toneMapping }; }))
        .toEqual({ tm: 0, exp: 1, env: 'procedural', rs: 'none' });
});

test('the altitude tour hops to the next object up by page altitude on an ARC, never through the planet', async ({ page }) => {
    await boot(page);
    await enableSuite(page, 'starlink');
    await page.evaluate(() => window.__ua.globe.followSatellite('iss'));
    await step(page, 90);
    const issAlt = await page.evaluate(() => window.__ua.globe.getFollowInfo().altKm);
    const pick = await page.evaluate(() => window.__ua.globe.followNeighbourByAltitude(1));
    // The next object up may be a named probe or a catalogue dot: the tour
    // spans both. Either way it is higher than the ISS.
    expect(['sat', 'catalog']).toContain(pick.kind);
    expect(pick.altKm).toBeGreaterThan(issAlt);
    // The flight is an arc: sample it frame by frame; the eye never dips
    // below the lower of its two ends, and rises above both mid-way.
    const flight = await page.evaluate(([dt]) => {
        const g = window.__ua.globe, c = g._controls;
        const arc = c.getFlightArc();
        const rs = [];
        for (let i = 0; i < 400 && c.isFlying(); i++) { g.stepFrames(1, dt, { render: 'none' }); rs.push(g._camera.position.length()); }
        return { arc: arc && { r0: arc.r0, r1: arc.r1, bulge: arc.bulge, angle: arc.angle, straight: arc.straight }, min: Math.min(...rs), max: Math.max(...rs), n: rs.length };
    }, [DT]);
    expect(flight.arc).not.toBeNull();
    expect(flight.arc.straight).toBe(false);
    expect(flight.min).toBeGreaterThan(Math.min(flight.arc.r0, flight.arc.r1) - 1e-6);
    expect(flight.max).toBeGreaterThan(Math.max(flight.arc.r0, flight.arc.r1) + 0.5 * flight.arc.bulge);
    // NEGATIVE CONTROL: the straight chord between the same two eyes dives
    // below the lower end (into the planet for a wide hop).
    const chordLow = await page.evaluate(async ([r0, r1, angle]) => {
        // The chord's closest approach for two points at r0, r1 separated by `angle`.
        const a = [r0, 0, 0], b = [r1 * Math.cos(angle), r1 * Math.sin(angle), 0];
        let min = Infinity;
        for (let i = 0; i <= 200; i++) { const t = i / 200; min = Math.min(min, Math.hypot(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)); }
        return min;
    }, [flight.arc.r0, flight.arc.r1, flight.arc.angle]);
    expect(chordLow).toBeLessThan(Math.min(flight.arc.r0, flight.arc.r1) - 0.01);
    // After the hand-off the chase holds the picked object.
    await page.waitForTimeout(2600);
    await step(page, 60);
    const info = await page.evaluate(() => window.__ua.globe.getFollowInfo());
    expect(info.kind).toBe(pick.kind);
    expect(info.id).toBe(pick.key);
    expect(info.altKm).toBeGreaterThan(issAlt);
});
