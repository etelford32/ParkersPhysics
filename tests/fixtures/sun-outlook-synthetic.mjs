// tests/fixtures/sun-outlook-synthetic.mjs — a SYNTHETIC active Sun for the
// hero's "Next 24 h" preview (js/hero-sun.js + js/hero-rope-layer.js).
// NOAA and DONKI are egress-blocked from the build environment, so the
// browser gates serve these instead. Nothing here is a real observation.
//
//   synthRegions(nowMs)  → an /api/noaa/regions payload (the relay's shape:
//                          data.regions with a HISTORY row for one region,
//                          the way SWPC's solar_regions.json carries it)
//   synthBus(nowMs)      → a swpc-feed-shaped bus state: X-ray, one located
//                          M flare, and a CME catalogue in four directions
//                          (one Earth-directed, one fresh enough to be seen
//                          lifting off)

const HOUR = 3600e3;

export function synthRegions(nowMs = Date.now()) {
    const day = new Date(nowMs).toISOString().slice(0, 10);
    const prev = new Date(nowMs - 86400e3).toISOString().slice(0, 10);
    const row = (region, location, lat, lon, area, mag, pm, px, date = day) => ({
        region, observed_date: date, location, latitude_deg: lat, stonyhurst_lon_deg: lon,
        area, mag_class: mag, spot_class: 'Eki', num_spots: Math.round(area / 20),
        c_flare_probability: Math.min(99, pm * 2), m_flare_probability: pm, x_flare_probability: px,
    });
    const regions = [
        row(4230, 'N14W49', 14, 49, 520, 'BGD', 45, 10, prev),     // yesterday's report — superseded
        row(4230, 'N14W62', 14, 62, 540, 'BGD', 45, 10),
        row(4231, 'S18W12', -18, 12, 340, 'BG', 25, 5),
        row(4232, 'N08E24', 8, -24, 180, 'B', 10, 1),
        row(4233, 'S09E58', -9, -58, 650, 'BGD', 55, 15),
        row(4234, 'N22W84', 22, 84, 90, 'A', 1, 1),
        row(4235, 'S25E05', -25, -5, 60, 'B', 5, 1),
    ];
    return { source: 'SYNTHETIC fixture', data: { updated: new Date(nowMs).toISOString(), region_count: regions.length, regions } };
}

export function synthBus(nowMs = Date.now()) {
    const iso = (h) => new Date(nowMs - h * HOUR).toISOString();
    return {
        xray_flux: 1.2e-5,
        xray_class: 'M1.2',
        derived: { xray_intensity: 0.55, storm_level: 0, kp_norm: 0.2 },
        solar_wind: { speed: 480, density: 5, bz: -2 },
        donki_cme_at: nowMs - 5 * 60e3,
        flares: [
            { time: new Date(nowMs - 12 * 60e3), cls: 'M1.2', parsed: { letter: 'M' }, location: 'N14W62' },
        ],
        recent_cmes: [
            { time: iso(30), speed: 1400, latitude: -10, longitude: 15, halfAngle: 45, earthDirected: true, cme_id: 'SYN-1' },
            { time: iso(8), speed: 900, latitude: 20, longitude: 72, halfAngle: 35, earthDirected: false, cme_id: 'SYN-2' },
            { time: iso(3), speed: 1200, latitude: -15, longitude: -42, halfAngle: 40, earthDirected: false, cme_id: 'SYN-3' },
            { time: iso(0.5), speed: 750, latitude: 14, longitude: 62, halfAngle: 30, earthDirected: false, cme_id: 'SYN-4' },
        ],
    };
}
