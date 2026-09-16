// js/corona-volumetric-mount.js
//
// Phase 4.3 — mount the AIA-style volumetric corona raymarcher (defined
// in ./corona-volumetric.js) as the active corona renderer for sun.html.
//
// The volumetric shader does proper DEM raymarching with 6 AIA passband
// responses, AR-anchored loop arcades (Joy's-law tilted), coronal-hole
// subtraction, channel-aware filament/prominence extinction, and flare-
// hot component scaled by GOES X-ray flux. This module wires it to the
// live AR/hole/flare data from sun.html and gives back a small handle
// for runtime control (channel switch, visibility, AR refresh).

import * as THREE from 'three';
import {
    EUV_CHANNELS, N_AR_SLOTS, N_HOLE_SLOTS, N_PULSE_SLOTS,
    CORONA_VOL_VERT, CORONA_VOL_FRAG,
} from './corona-volumetric.js';

const CORONA_RADIUS = 2.5;            // R☉ — outer extent of the volume

/**
 * Mount the volumetric corona on the given scene.
 *
 * @param {object} opts
 * @param {THREE.Scene} opts.scene
 * @param {object} opts.baseUniforms — sun.html's uniforms object; we share
 *                                     u_time / u_activity references where
 *                                     compatible so they auto-update.
 * @param {string} [opts.channel='171']
 * @param {number} [opts.renderOrder=4]
 */
export function mountVolumetricCorona({ scene, baseUniforms, channel = '171', renderOrder = 4 }) {
    if (!scene) throw new Error('corona-volumetric-mount: scene required');
    if (!baseUniforms) throw new Error('corona-volumetric-mount: baseUniforms required');

    const ch = EUV_CHANNELS[channel] || EUV_CHANNELS['171'];

    // AR / hole slot arrays — pre-allocate vec4 instances and mutate in place
    // so the GPU upload only needs to push the slot data each refresh.
    const u_regions = [];
    for (let i = 0; i < N_AR_SLOTS; i++) u_regions.push(new THREE.Vector4(0, 0, 0, 0));
    const u_holes = [];
    for (let i = 0; i < N_HOLE_SLOTS; i++) u_holes.push(new THREE.Vector4(0, 0, 0, 0));
    // Nanoflare heat pulses (sun.html feeds them per frame; see the shader header).
    const u_pulses = [], u_pulseE = [];
    for (let i = 0; i < N_PULSE_SLOTS; i++) { u_pulses.push(new THREE.Vector4(0, 0, 0, 1)); u_pulseE.push(new THREE.Vector2(0, 24)); }

    // Build the uniform set. Where compatible we share *the same uniform
    // object* with the host page (e.g. u_time, u_activity) so a single
    // .value write updates both shaders.
    //
    // u_flare_t in this shader is a 0..1 *impulsive flash decay* (matches
    // sun.html's u_flare_intensity, NOT its u_flare_t). u_flare_lon here
    // is a vec2 (lat, lon) — a different shape from sun.html's two scalar
    // uniforms — so we keep our own and sync via the .tickFlareLatLon()
    // method each frame.
    const uniforms = {
        u_sun_world:          { value: new THREE.Vector3(0, 0, 0) },
        u_sun_radius:         { value: 1.0 },
        u_corona_radius:      { value: CORONA_RADIUS },

        u_regions:            { value: u_regions },
        u_nRegions:           { value: 0 },
        u_holes:              { value: u_holes },
        u_nHoles:             { value: 0 },

        u_xray_norm:          { value: 0.0 },
        u_flare_t:            baseUniforms.u_flare_intensity || { value: 0.0 },
        u_activity:           baseUniforms.u_activity        || { value: 0.5 },
        u_flare_lon:          { value: new THREE.Vector2(0, 0) },

        u_channel_logT:       { value: ch.logT },
        u_channel_sigT:       { value: ch.sigma },
        u_channel_color:      { value: new THREE.Color(ch.color[0], ch.color[1], ch.color[2]) },
        u_channel_intensity:  { value: 1.6 },
        u_filament_opacity:   { value: ch.filOpacity },

        u_time:               baseUniforms.u_time || { value: 0 },
        u_unrest:             baseUniforms.u_unrest || { value: 0 },

        // Phase 3 — loop-density atlas + jitter (see corona-loop-density.js)
        u_loopTex:            { value: null },
        u_loopOn:             { value: 0.0 },
        u_loopDims:           { value: new THREE.Vector3(256, 128, 32) },
        u_loopTiles:          { value: new THREE.Vector2(4, 8) },
        u_loopRMax:           { value: CORONA_RADIUS },
        u_loopGain:           { value: 1.0 },
        u_jitter:             { value: 0.0 },
        u_marchLegacy:        { value: 0.0 },

        u_pulses:             { value: u_pulses },
        u_pulseE:             { value: u_pulseE },
        u_nPulses:            { value: 0 },

        // Observed off-limb plane: (weight, rEdge, 0, 0) + sky-plane normal (sun.html per frame)
        u_obsLimb:            { value: new THREE.Vector4(0, 1.28, 0, 0) },
        u_obsLimbN:           { value: new THREE.Vector3(0, 0, 1) },
    };

    const material = new THREE.ShaderMaterial({
        vertexShader:   CORONA_VOL_VERT,
        fragmentShader: CORONA_VOL_FRAG,
        uniforms,
        transparent:    true,
        depthWrite:     false,
        side:           THREE.FrontSide,
        blending:       THREE.AdditiveBlending,
    });

    // Outer corona bounding sphere — front face is the ray entry point.
    const geom = new THREE.SphereGeometry(CORONA_RADIUS, 64, 32);
    const mesh = new THREE.Mesh(geom, material);
    mesh.renderOrder = renderOrder;
    mesh.frustumCulled = false;
    mesh.userData.label = 'volumetric corona (Phase 4.3)';
    // Phase 3: the corona is rendered by js/corona-accumulate.js on LAYER 1
    // (camera.layers is 0 in the main RenderPass), jittered and integrated
    // over frames. If no accumulation pass adopts it, call
    // `adoptMainScene()` to put it back on layer 0.
    mesh.layers.set(1);
    scene.add(mesh);

    let _currentChannel = channel;
    let _loopStats = null;
    let _onChannelChange = null;

    return {
        mesh, material, uniforms,
        get currentChannel() { return _currentChannel; },

        /** Switch AIA channel ('94' / '131' / '171' / '193' / '211' / '304' / 'white'). */
        setChannel(name) {
            const c = EUV_CHANNELS[name];
            if (!c) {
                console.warn('[corona-vol] unknown channel:', name);
                return;
            }
            uniforms.u_channel_logT.value      = c.logT;
            uniforms.u_channel_sigT.value      = c.sigma;
            uniforms.u_channel_color.value.setRGB(c.color[0], c.color[1], c.color[2]);
            uniforms.u_filament_opacity.value  = c.filOpacity;
            _currentChannel = name;
            if (_onChannelChange) _onChannelChange(name);
        },

        /** Phase 3 — install the loop-density slice atlas (a THREE.DataTexture from rasterizeLoopDensity). */
        setLoopDensity(texture, rast) {
            if (!texture || !rast || rast.empty) {
                uniforms.u_loopOn.value = 0.0;
                uniforms.u_loopTex.value = null;
                _loopStats = rast ? rast.stats : null;
                return;
            }
            uniforms.u_loopTex.value   = texture;
            uniforms.u_loopDims.value.set(rast.dims.nlon, rast.dims.nlat, rast.dims.nh);
            uniforms.u_loopTiles.value.set(rast.layout.tilesX, rast.layout.tilesY);
            uniforms.u_loopRMax.value  = rast.rMax;
            uniforms.u_loopOn.value    = 1.0;
            _loopStats = rast.stats;
        },
        get loopStats() { return _loopStats; },
        get loopOn() { return uniforms.u_loopOn.value > 0.5; },

        /** Per-frame jitter phase (the accumulation pass drives this). */
        setJitter(phase) { uniforms.u_jitter.value = phase; },

        /** The accumulation pass registers here so a channel switch resets its history. */
        onChannelChange(fn) { _onChannelChange = fn; },

        /** Render in the main scene instead (no accumulation pass). */
        adoptMainScene() { mesh.layers.set(0); },

        setVisible(b) { mesh.visible = !!b; },

        /**
         * Refresh AR + coronal-hole positions.
         *
         * @param {Array<{ latRad, lonRad, area, complex }>} activeRegions
         * @param {Array<{ latRad, lonRad, depth }>}         holes
         */
        update(activeRegions, holes) {
            const ars = (activeRegions || []).slice(0, N_AR_SLOTS);
            for (let i = 0; i < N_AR_SLOTS; i++) {
                const v = u_regions[i];
                if (i < ars.length) {
                    const a = ars[i];
                    const cl = Math.cos(a.latRad);
                    const x  = cl * Math.sin(a.lonRad);
                    const y  = Math.sin(a.latRad);
                    const z  = cl * Math.cos(a.lonRad);
                    const sign = a.complex ? -1 : 1;
                    const w  = sign * Math.max(0, Math.min(1, a.area || 0));
                    v.set(x, y, z, w);
                } else {
                    v.set(0, 0, 0, 0);
                }
            }
            uniforms.u_nRegions.value = ars.length;

            const hs = (holes || []).slice(0, N_HOLE_SLOTS);
            for (let i = 0; i < N_HOLE_SLOTS; i++) {
                const v = u_holes[i];
                if (i < hs.length) {
                    const h  = hs[i];
                    const cl = Math.cos(h.latRad);
                    v.set(cl * Math.sin(h.lonRad), Math.sin(h.latRad), cl * Math.cos(h.lonRad),
                          Math.max(0, Math.min(1, h.depth || 0)));
                } else {
                    v.set(0, 0, 0, 0);
                }
            }
            uniforms.u_nHoles.value = hs.length;
        },

        /**
         * Nanoflare heat pulses: [{ x, y, z (sun-local, R☉), sigma (R☉), amp (0–1), log10E (erg) }],
         * at most N_PULSE_SLOTS used. An empty list clears them.
         */
        setPulses(list) {
            const n = Math.min(list ? list.length : 0, N_PULSE_SLOTS);
            for (let i = 0; i < N_PULSE_SLOTS; i++) {
                if (i < n) {
                    const p = list[i];
                    u_pulses[i].set(p.x, p.y, p.z, Math.max(1e-3, p.sigma));
                    u_pulseE[i].set(Math.max(0, p.amp), p.log10E);
                } else {
                    u_pulses[i].set(0, 0, 0, 1);
                    u_pulseE[i].set(0, 24);
                }
            }
            uniforms.u_nPulses.value = n;
        },
        get pulseCount() { return uniforms.u_nPulses.value; },

        /** Observed off-limb billboard coverage: weight 0–1, the frame's edge radius (R☉) and the sky-plane normal. */
        setObservedLimb(weight, rEdge, nx, ny, nz) {
            uniforms.u_obsLimb.value.set(Math.max(0, Math.min(1, weight || 0)), Math.max(1.02, rEdge || 1.28), 0, 0);
            uniforms.u_obsLimbN.value.set(nx, ny, nz).normalize();
        },

        /** Sync the (lat, lon) of the most recent flare. */
        tickFlareLatLon(latRad, lonRad) {
            uniforms.u_flare_lon.value.set(latRad, lonRad);
        },

        /** Set 0..1 normalized GOES X-ray flux (drives the flare-hot DEM). */
        setXrayNorm(n) {
            uniforms.u_xray_norm.value = Math.max(0, Math.min(1, n));
        },

        dispose() {
            scene.remove(mesh);
            geom.dispose();
            material.dispose();
        },
    };
}

/** Outer radius of the volumetric corona shell, R☉. */
export const VOL_CORONA_RADIUS = CORONA_RADIUS;

/** Re-export the channel table so callers can build UI without a separate import. */
export { EUV_CHANNELS };
