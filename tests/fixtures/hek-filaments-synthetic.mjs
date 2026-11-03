// tests/fixtures/hek-filaments-synthetic.mjs — a SYNTHETIC /api/hek/filaments
// payload (the js/hek-filaments.js normalised shape) for the hero's live Sun.
// www.lmsal.com is egress-blocked from the build environment. Nothing here is
// a real detection: three disc filaments and two limb prominences, placed so
// at least one stands on each limb whatever the date.
export function synthFilaments(nowMs = Date.now()) {
    const t = new Date(nowMs - 2 * 3600e3).toISOString();
    const row = (event_type, lat_deg, lon_deg, length_deg, tilt_deg, frm_name = 'SYNTH') =>
        ({ event_type, lat_deg, lon_deg, lon_carrington_deg: null, length_deg, tilt_deg, chirality: null, frm_name, time: t, detections: 1 });
    return {
        source: 'SYNTHETIC fixture',
        data: {
            updated: new Date(nowMs).toISOString(), window_hours: 48, count: 5,
            filaments: [
                row('FI', 28, -20, 34, 25),          // long quiescent filament, NE quadrant
                row('FI', -35, 30, 22, -40),         // southern, tilted
                row('FI', 12, 5, 14, 10),            // near disc centre
                row('PG', 40, 86, 18, 70),           // prominence on the W limb
                row('PG', -22, -88, 26, 60),         // prominence on the E limb
            ],
            field_map: {}, unmapped_keys: [], counts: { FI: 3, PG: 2 }, detectors: ['SYNTH'], length_clamped: 0, dropped: 0,
        },
    };
}
