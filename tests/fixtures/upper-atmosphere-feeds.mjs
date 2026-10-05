/**
 * upper-atmosphere-feeds.mjs — every network feed upper-atmosphere.html
 * touches at boot, served from fixtures, so a browser gate can ask "does the
 * page boot without console errors?" and get an answer about the PAGE, not
 * about whether this machine can reach NOAA, CelesTrak and unpkg.
 *
 * Until 2026-10-05 the smoke spec ran against the live feeds and, wherever
 * they are egress-blocked (cloud sandboxes, some CI), failed on ~50
 * "Failed to load resource" lines that said nothing about the page. A
 * filter would hide them, but a filter wide enough to hide 503s from feeds
 * is wide enough to hide a 404 on one of the page's own modules — so the
 * feeds get realistic bodies instead, and the page takes its normal path.
 * The shapes are the ones the page's own clients read:
 *
 *   /api/noaa/f107-history   js/f107-history.js (rows: {date, flux_sfu, kind})
 *   /api/noaa/ap-history     js/ap-history.js   (rows: {t, ap, kind}, current_ap_array)
 *   SWPC f107_cm_flux.json   js/upper-atmosphere-engine.js fetchLiveIndices ({flux}[])
 *   SWPC planetary K index   same (header row + [time_tag, Kp, …] rows)
 *   /api/celestrak/tle       tests/fixtures/sat-suites-synthetic.mjs (checksummed TLEs)
 *   three-globe textures     the self-hosted NASA maps in assets/earth (same imagery)
 *   /api/telemetry/log       204 — the local dev server does not implement it (501)
 *
 * `routeUpperAtmosphereFeeds(page, { down: true })` serves the opposite world —
 * every feed 503 / unreachable — for the degraded-path gate.
 */

import { readFile } from 'node:fs/promises';
import { syntheticCatalogue, syntheticRecord, nForAlt } from './sat-suites-synthetic.mjs';

const here = (p) => new URL(p, import.meta.url);
const DAY = 86400e3;

const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** f107-history: ~120 observed days around 150 SFU with a 27-day ripple. */
export function f107History(nowMs) {
    const rows = [];
    for (let k = 119; k >= 0; k--) {
        const t = new Date(nowMs - k * DAY);
        rows.push({ date: t.toISOString().slice(0, 10), flux_sfu: 150 + 20 * Math.sin((2 * Math.PI * k) / 27), kind: 'observed' });
    }
    return {
        source: 'fixture (tests/fixtures/upper-atmosphere-feeds.mjs)',
        age_seconds: 3600, age_hours: 1, freshness: 'fresh', stale: false,
        data: {
            observed_days: rows.length, predicted_days: 0,
            computed_f107a_centred: 150, computed_f107a_trailing: 150, computed_f107a_27d_trailing: 150,
            rows, warnings: [],
        },
    };
}

/** ap-history: 3-hourly Ap over 3 days, quiet-to-unsettled. */
export function apHistory(nowMs) {
    const rows = [];
    const t0 = Math.floor(nowMs / (3 * 3600e3)) * 3 * 3600e3;
    for (let k = 23; k >= 0; k--) rows.push({ t: new Date(t0 - k * 3 * 3600e3).toISOString(), ap: 12 + (k % 5) * 2, kind: 'observed' });
    const apArray = [14, 12, 14, 16, 18, 13, 12];
    return {
        source: 'fixture (tests/fixtures/upper-atmosphere-feeds.mjs)',
        age_seconds: 1800, age_hours: 0.5, freshness: 'fresh', stale: false,
        data: {
            observed_ticks: rows.length, predicted_ticks: 0, cadence_hours: 3,
            current_ap_array: apArray, current_daily_ap: apArray[0], rows, warnings: [],
        },
    };
}

function swpcF107(nowMs) {
    return Array.from({ length: 30 }, (_, k) => ({
        time_tag: new Date(nowMs - (29 - k) * DAY).toISOString().slice(0, 19),
        frequency: 2800, flux: 150 + 10 * Math.sin(k / 4), reporting_schedule: 'Noon', ninety_day_mean: 148,
    }));
}

function swpcKp(nowMs) {
    const rows = [['time_tag', 'Kp', 'a_running', 'station_count']];
    for (let k = 23; k >= 0; k--) {
        rows.push([new Date(nowMs - k * 3 * 3600e3).toISOString().replace('T', ' ').slice(0, 23), '2.33', '9', '8']);
    }
    return rows;
}

/** A plausible record for a NORAD the catalogue fixture does not name. */
function anyNorad(norad, nowMs) {
    const n = Number(norad) || 1;
    return syntheticRecord({
        name: `FIXTURE ${n}`, norad: n, incDeg: 40 + (n % 50), raanDeg: (n * 37) % 360, ecc: 0.0008,
        argpDeg: (n * 11) % 360, mDeg: (n * 23) % 360, nRevDay: nForAlt(400 + (n % 300)), epochMs: nowMs - 6 * 3600e3,
    });
}

/** A small fragment cloud for one debris event group. */
function debrisGroup(group, nowMs) {
    const base = { 'fengyun-1c-debris': [98.6, 850], 'cosmos-1408-debris': [82.6, 470],
        'iridium-33-debris': [86.4, 780], 'cosmos-2251-debris': [74.0, 790] }[group] || [70, 700];
    let norad = 90000 + [...group].reduce((a, c) => a + c.charCodeAt(0), 0) * 10;
    return Array.from({ length: 12 }, (_, k) => syntheticRecord({
        name: `${group.toUpperCase()} DEB ${k}`, norad: norad++, incDeg: base[0] + (k % 3) * 0.2,
        raanDeg: (k * 30) % 360, ecc: 0.002 + k * 0.0005, argpDeg: k * 17, mDeg: k * 29,
        nRevDay: nForAlt(base[1] + (k - 6) * 15), epochMs: nowMs - 12 * 3600e3,
    }));
}

const TEXTURES = {
    'earth-blue-marble.jpg': 'day-1k.webp',
    'earth-night.jpg':       'lights-1k.webp',
    'earth-topology.png':    'relief-1k.webp',
    'earth-water.png':       'water-1k.webp',
};

/**
 * Serve every feed the page reaches for. `down: true` answers each with the
 * failure a dead upstream produces (503 for our relays, an aborted request
 * for a third-party host) — the page must still boot without throwing.
 */
export async function routeUpperAtmosphereFeeds(page, { nowMs = Date.now(), down = false } = {}) {
    const catalogue = syntheticCatalogue(nowMs);

    await page.route('**/api/telemetry/**', (r) => r.fulfill({ status: 204, body: '' }));

    if (down) {
        await page.route('**/api/noaa/**', (r) => json(r, { error: 'upstream_unavailable' }, 503));
        await page.route('**/api/celestrak/**', (r) => json(r, { error: 'upstream_unavailable' }, 503));
        await page.route('https://services.swpc.noaa.gov/**', (r) => r.abort('internetdisconnected'));
        await page.route('https://unpkg.com/three-globe@*/**', (r) => r.abort('internetdisconnected'));
        return;
    }

    await page.route('**/api/noaa/f107-history**', (r) => json(r, f107History(nowMs)));
    await page.route('**/api/noaa/ap-history**', (r) => json(r, apHistory(nowMs)));
    await page.route('https://services.swpc.noaa.gov/json/f107_cm_flux.json', (r) => json(r, swpcF107(nowMs)));
    await page.route('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json', (r) => json(r, swpcKp(nowMs)));

    await page.route('**/api/celestrak/tle**', (route) => {
        const q = new URL(route.request().url()).searchParams;
        const norad = q.get('norad');
        if (norad) {
            const hit = Object.values(catalogue).flat().find((x) => String(x.norad_id) === norad);
            return json(route, { satellites: [hit || anyNorad(norad, nowMs)] });
        }
        const g = q.get('group');
        const sats = catalogue[g] || (/-debris$/.test(g || '') ? debrisGroup(g, nowMs) : null);
        if (!sats) return json(route, { error: 'fixture has no such group', group: g }, 404);
        return json(route, { satellites: sats, source: 'synthetic fixture', source_format: 'tle', fetched: new Date(nowMs).toISOString() });
    });

    const textures = {};
    for (const [name, file] of Object.entries(TEXTURES)) {
        textures[name] = await readFile(here(`../../assets/earth/${file}`));
    }
    await page.route('https://unpkg.com/three-globe@*/example/img/*', (route) => {
        const name = route.request().url().split('/').pop();
        const body = textures[name];
        return body
            ? route.fulfill({ status: 200, contentType: 'image/webp', body })
            : route.fulfill({ status: 404, body: '' });
    });
}
