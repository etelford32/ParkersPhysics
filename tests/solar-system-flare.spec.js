/**
 * solar-system-flare.spec.js — flare / active-region geometry on the orrery.
 * ═══════════════════════════════════════════════════════════════════════════
 * solar-system.html draws the Sun's activity RELATIVE TO EARTH: a NOAA region
 * published in Carrington longitude has to land at Earth's drawn azimuth plus
 * its Stonyhurst longitude (west ahead, in the sense the Sun spins), the
 * shader's sunspot slot has to be the object-space azimuth of that, the
 * loops / prominences / flare arcade have to ride the sun frame so they
 * co-rotate with the spots, the CME cone has to leave along the flare's
 * world azimuth, and the Sun has to spin PROGRADE with the planets' orbits.
 *
 * Measured before the fix (2026-09-13): Carrington longitudes were placed as
 * world azimuths with Earth ignored, the mesh-rotation sign was subtracted
 * where it must be added, loops sat world-fixed at yet another longitude,
 * and the Sun spun retrograde to its own Parker spiral. This spec drives the
 * page with ONE synthetic `swpc-update` (the feed's own event contract) and
 * reads every consumer back through `window.__solarFlare`.
 */

import { test, expect } from '@playwright/test';
import * as FG from '../js/flare-geometry.js';

const DEG = Math.PI / 180;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const angDiff = (a, b) => Math.abs(wrap(a - b));

const IGNORED_CONSOLE_ERRORS = [
    /fonts\.googleapis\.com/, /\/api\/telemetry\//, /\/api\/horizons/, /\/api\/noaa\//, /\/api\/donki\//,
    /\/api\/solar/, /\/api\/health/, /\/api\/neo\//, /services\.swpc\.noaa\.gov/, /Failed to load resource/,
    /net::ERR/, /\[swpc-feed\]/, /\[earth-sim-bridge\]/, /supabase/i, /WebSocket/, /upstream_unavailable/,
];

function collectPageErrors(page) {
    const errors = [];
    page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
    page.on('console', message => {
        if (message.type() !== 'error') return;
        const text = message.text();
        const location = message.location?.()?.url || '';
        if (IGNORED_CONSOLE_ERRORS.some(p => p.test(text) || p.test(location))) return;
        errors.push(text);
    });
    return errors;
}

/** The feed's event contract (js/swpc-feed.js _buildState), filled with quiet defaults. */
function swpcState({ regions, flares, flareLoc, cls = 'X1.5' }) {
    return {
        __synthetic: true,
        solar_wind: { speed: 450, density: 5, temperature: 8e4, bt: 6, bz: -2, bx: 1, by: 1 },
        kp: 3, xray_flux: 1.5e-4, xray_class: cls, xray_series: [], proton_series: [],
        flare_class: cls, flare_letter: cls[0], flare_time: flares[0]?.time ?? null,
        flare_location: flareLoc, flare_watts: 1.5e-4,
        active_regions: regions, flares, recent_flares: flares,
        derived: {
            wind_speed_norm: 0.5, wind_density_norm: 0.5, bt_norm: 0.5, bz: -2, bz_southward: 0.2,
            xray_intensity: 0.9, kp_norm: 0.33, storm_level: 0, f107_norm: 0.5,
            proton_10mev_norm: 0, electron_2mev_norm: 0, speed: 450, text: 'quiet',
        },
        status: 'ok', lastUpdated: new Date(), storm_mode: false,
        new_major_flare: true,
        flare_direction: (() => { const p = FG.parseStonyhurst(flareLoc); return { lat_rad: p.latDeg * DEG, lon_rad: p.lonDeg * DEG }; })(),
        proton_flux_10mev: 0.1, proton_flux_100mev: 0.01, electron_flux_2mev: 100, sep_storm_level: 0,
        aurora_power_north: 20, aurora_power_south: 20, aurora_activity: 'quiet', active_alerts: [],
        f107_flux: 150, recent_cmes: [], earth_directed_cme: null, cme_eta_hours: null,
        donki_notifications: [], donki_flares: [], gst_events: [], current_gst: null,
        sep_events: [], recent_sep_event: null, radiation_storm_active: false, new_cme_detected: false,
        dst_index: -5, kp_1min: 3, proton_diff_1mev: 0,
    };
}

async function openPage(page) {
    // Feeds are unrouted in CI and degrade by design; fail them fast so the
    // real feed's first (empty) dispatch lands before our synthetic one.
    await page.route('**/services.swpc.noaa.gov/**', r => r.abort());
    await page.route('**/api/**', r => r.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"upstream_unavailable"}' }));
    // The real feed polls in three tiers and dispatches on each (empty, with
    // the feeds down); one landing after our synthetic event would replace
    // the placed regions and race the assertions (it did, on a retry). Only
    // synthetic events reach the page in this spec.
    await page.addInitScript(() => {
        window.__swpcDropped = 0;
        const orig = window.dispatchEvent.bind(window);
        window.dispatchEvent = (ev) => {
            if (ev?.type === 'swpc-update' && !ev.detail?.__synthetic) { window.__swpcDropped++; return true; }
            return orig(ev);
        };
    });
    await page.goto('/solar-system.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__solarFlare && !!window.__neoLab, null, { timeout: 30_000 });
    await page.waitForTimeout(1500);
}

test.describe('solar-system.html flare geometry', () => {

    test('regions, spots, loops, arcade and CME all sit at Earth-relative azimuths and ride a prograde Sun', async ({ page }) => {
        test.setTimeout(120_000);
        const errors = collectPageErrors(page);
        await openPage(page);
        // Let the real feed's first dispatch (empty, feeds down) happen first if it is going to.

        // Two regions given in CARRINGTON longitude so that they are W30 and E60 right now.
        const l0 = FG.centralMeridianL0Deg(new Date());
        const carr = (stony) => ((stony + l0) % 360 + 360) % 360;
        const regions = [
            { region: 14101, lat_deg: 14,  lon_deg: carr(30),  lat_rad: 14 * DEG,  lon_rad: carr(30) * DEG,  area_norm: 0.6, mag_class: 'beta-gamma-delta', is_complex: true,  num_spots: 20 },
            { region: 14102, lat_deg: -20, lon_deg: carr(-60), lat_rad: -20 * DEG, lon_rad: carr(-60) * DEG, area_norm: 0.2, mag_class: 'beta',            is_complex: false, num_spots: 4  },
        ];
        const flares = [{ cls: 'X1.5', time: new Date(Date.now() - 10 * 60e3), location: 'N12W40', parsed: { letter: 'X', magnitude: 1.5 } }];
        await page.evaluate((state) => {
            state.flares[0].time = new Date(state.flares[0].time);
            window.dispatchEvent(new CustomEvent('swpc-update', { detail: state }));
        }, swpcState({ regions, flares, flareLoc: 'N12W40' }));
        await page.waitForTimeout(400);

        const s0 = await page.evaluate(() => window.__solarFlare.state);
        expect(s0.spinSign).toBe(1);
        expect(Math.abs(s0.l0Deg - l0)).toBeLessThan(0.05);

        // Regions: Carrington → Stonyhurst → Earth-relative world azimuth → object azimuth (the shader slot).
        expect(s0.regions.length).toBe(2);
        const [r1, r2] = s0.regions;
        expect(Math.abs(r1.stony_deg - 30)).toBeLessThan(0.05);
        expect(Math.abs(r2.stony_deg - (-60))).toBeLessThan(0.05);
        expect(angDiff(r1.world_az, s0.earthAz + 30 * DEG), 'W30 is 30° AHEAD of Earth in the spin sense').toBeLessThan(1e-3);
        expect(angDiff(r2.world_az, s0.earthAz - 60 * DEG), 'E60 is 60° behind').toBeLessThan(1e-3);
        expect(angDiff(r1.slot_lon, FG.objectAzimuthForWorld(r1.world_az, s0.sunRotY)), 'shader slot = object azimuth').toBeLessThan(1e-6);
        expect(angDiff(r1.lon_obj, r1.slot_lon)).toBeLessThan(1e-9);
        // …and the shader's arDir convention (cos lat cos lon, sin lat, cos lat sin lon) is the stage's latLonToVec3: same azimuth.
        const dirW30 = FG.heliocentricSiteDirection({ latRad: 14 * DEG, lonRad: 30 * DEG, earthAzRad: s0.earthAz, spinSign: 1 });
        // (Earth-relative: the drawn Earth moves ~1e-6 rad in the 400 ms between the handler and this read.)
        expect(angDiff(FG.heliocentricAzimuth(dirW30), r1.world_az)).toBeLessThan(1e-4);

        // Loops and prominences ride the sun frame, which follows the mesh.
        expect(s0.loopMeshes).toBeGreaterThan(0);
        expect(s0.loopsInSunFrame).toBe(s0.loopMeshes);
        expect(Math.abs(s0.sunFrameRotY - s0.sunRotY)).toBeLessThan(1e-9);

        // The flare: site at N12W40 relative to Earth, arcade up, small, on the prior, in the sun frame.
        expect(s0.flare, 'a flare site was set from the located flare').toBeTruthy();
        expect(s0.flare.cls).toBe('X');
        expect(angDiff(s0.flare.stonyLonRad, 40 * DEG)).toBeLessThan(1e-9);
        expect(angDiff(s0.flare.worldAz, s0.earthAz + 40 * DEG)).toBeLessThan(1e-3);
        expect(s0.flare.arcade.active).toBe(true);
        expect(s0.flare.arcade.loops).toBeGreaterThan(0);
        expect(s0.flare.arcade.pil).toBe('prior');
        expect(s0.flare.arcade.drawnApexR, 'reads, does not dominate').toBeGreaterThan(1.0);
        expect(s0.flare.arcade.drawnApexR).toBeLessThan(1.25);
        expect(s0.flare.arcade.heightScale).toBeLessThan(1);
        // The arcade's site, read back through the scene graph, is at the flare's world azimuth and latitude.
        const [sx, sy, sz] = s0.flare.siteWorld;
        expect(angDiff(Math.atan2(sz, sx), s0.flare.worldAz), 'arcade group world azimuth = flare azimuth').toBeLessThan(1e-6);
        expect(Math.abs(sy - 1.5 * Math.sin(12 * DEG))).toBeLessThan(1e-6);
        expect(Math.abs(Math.hypot(sx, sy, sz) - 1.5)).toBeLessThan(1e-6);
        // Age carried in: a 10-minute-old flare is already partly aged (0.35 sim units per real second).
        expect(s0.flare.t).toBeGreaterThan(100);

        // The CME cone left along the flare's world azimuth (ballistic, not object space).
        expect(s0.cmeActive).toBe(true);
        expect(angDiff(s0.cmeAxisAz, s0.flare.worldAz)).toBeLessThan(1e-9);

        // Spin: a month per second → Earth's azimuth grows, the mesh rotation FALLS (prograde),
        // and the arcade's world azimuth advances by exactly the mesh's turn.
        await page.evaluate(() => window.__solarFlare.setSimSpeed(86400 * 30));
        await page.waitForTimeout(700);
        const s1 = await page.evaluate(() => window.__solarFlare.state);
        await page.evaluate(() => window.__solarFlare.setSimSpeed(1));
        expect(wrap(s1.earthAz - s0.earthAz), 'planets orbit with azimuth increasing').toBeGreaterThan(0.02);
        expect(s0.sunRotY - s1.sunRotY, 'mesh rotation decreases ⇒ its surface azimuth increases with the orbits').toBeGreaterThan(0.05);
        const turned = s0.sunRotY - s1.sunRotY;
        const [tx, , tz] = s1.flare.siteWorld;
        expect(angDiff(Math.atan2(tz, tx), s0.flare.worldAz + turned), 'arcade co-rotated with the Sun').toBeLessThan(1e-6);
        expect(Math.abs(s1.sunFrameRotY - s1.sunRotY)).toBeLessThan(1e-9);
        // The epoch site itself did not move; only the frame did.
        expect(angDiff(s1.flare.objAz, s0.flare.objAz)).toBeLessThan(1e-12);
        expect(s1.flare.t).toBeGreaterThan(s0.flare.t);

        // A repeat poll with the SAME flare does not restart the arcade's clock.
        await page.evaluate((state) => {
            state.flares[0].time = new Date(state.flares[0].time);
            state.new_major_flare = false;
            window.dispatchEvent(new CustomEvent('swpc-update', { detail: state }));
        }, swpcState({ regions, flares, flareLoc: 'N12W40' }));
        await page.waitForTimeout(200);
        const s2 = await page.evaluate(() => window.__solarFlare.state);
        expect(s2.flare.t).toBeGreaterThanOrEqual(s1.flare.t);

        expect(errors, errors.join('\n')).toHaveLength(0);
    });

    test('a flare list without a location leaves the arcade dark (never disk centre)', async ({ page }) => {
        test.setTimeout(60_000);
        await openPage(page);
        const state = swpcState({ regions: [], flares: [{ cls: 'M2.0', time: new Date(), location: null, parsed: { letter: 'M', magnitude: 2 } }], flareLoc: 'N01W01' });
        state.new_major_flare = false;
        state.flare_direction = null;
        state.flare_location = null;
        await page.evaluate((st) => {
            st.flares[0].time = new Date(st.flares[0].time);
            window.dispatchEvent(new CustomEvent('swpc-update', { detail: st }));
        }, state);
        await page.waitForTimeout(300);
        const s = await page.evaluate(() => window.__solarFlare.state);
        expect(s.flare).toBeNull();
        expect(s.regions).toHaveLength(0);
    });
});
