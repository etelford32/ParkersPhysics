/**
 * tests/open-meteo-request.mjs — every multi-location Open-Meteo URL this
 * site emits fits the request line, and the merged grid never reorders.
 *
 *   node tests/open-meteo-request.mjs
 *
 * Background (EARTHVIEW_LOD_UX_PLAN.md §1.1, measured 2026-10-26): four
 * callers each kept their own chunk constant (864/864/864/640) and built
 * 10.5–12.3 KB URLs; Open-Meteo's nginx answers HTTP 414 past ~8 KB. The
 * cron fell to the MET Norway fallback for 30 days; the browser feeds saw
 * a bare NetworkError. js/open-meteo-request.js is the ONE copy now.
 *
 * Gates:
 *   • chunkRanges partitions [0, n) in order; concatenation is the identity
 *   • the 2592-point merge through 400-location chunks equals the old
 *     864-location layout exactly (same row-major order, same coordinates)
 *   • every URL the cron / forecast ring / pressure-level feed / patch can
 *     emit is < MAX_URL_BYTES (7000) — including the worst-case 64×64 patch
 *     at 0.25° in the south-western quadrant, and with an apikey
 *   • chunkUrl REFUSES a URL over the ceiling (the old 864 layout must fail)
 *   • formatCoord is %g: no toFixed padding, exact half-degrees round-trip
 *
 * Pacing (2026-11-08 — production drew "Minutely API request limit exceeded"
 * on every run once the 414 was gone; Open-Meteo counts EACH LOCATION):
 *   • requestWeight follows the published weighting (locations × the >10
 *     variable / >14 day factors)
 *   • pacedChunkPlan covers the grid in order, never puts more than the
 *     budget in any trailing window, and needs the minimum window count
 *   • NEGATIVE CONTROL: the old 7 × 400 fan-out (all at t = 0) puts 2592
 *     weighted calls in one window — 4.3× the free tier's 600/min
 *   • an infinite budget (commercial key) collapses to one window
 */
import assert from 'node:assert/strict';
import {
    GRID, MAX_URL_BYTES, MAX_LOCATIONS_PER_REQUEST, OPEN_METEO_FORECAST_URL, OPEN_METEO_CUSTOMER_URL,
    chunkRanges, gridLatLon, gridChunkCoords, chunkUrl, mergeChunks,
    formatCoord, byteLength, locationsPerRequest, maxCoordBytes,
    FREE_TIER, DEFAULT_PACE, requestWeight, pacedChunkPlan, peakWindowWeight,
} from '../js/open-meteo-request.js';
import { planPatchRequests } from '../js/weather-patch.js';

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }
console.log('open-meteo-request.mjs');

// ── Grid record ──────────────────────────────────────────────────────────────
ok('GRID is the 72×36 5° grid with half-degree cell centres', () => {
    assert.equal(GRID.n, 2592);
    assert.equal(GRID.w * GRID.h, GRID.n);
    assert.equal(GRID.deg, 5);
    assert.deepEqual(gridLatLon(0), { lat: -87.5, lon: -177.5 });
    assert.deepEqual(gridLatLon(GRID.n - 1), { lat: 87.5, lon: 177.5 });
    assert.deepEqual(gridLatLon(72), { lat: -82.5, lon: -177.5 }, 'row-major: lat slow');
});

// ── chunkRanges ──────────────────────────────────────────────────────────────
ok('chunkRanges partitions [0, n) in order with no gaps or overlaps', () => {
    for (const [n, max] of [[2592, 400], [2592, 864], [4096, 388], [1, 400], [0, 400], [400, 400], [401, 400]]) {
        const r = chunkRanges(n, max);
        let next = 0;
        for (const { start, end } of r) {
            assert.equal(start, next, `n=${n} max=${max}: chunk starts where the previous ended`);
            assert.ok(end >= start && end - start + 1 <= max, `n=${n} max=${max}: chunk size ≤ max`);
            next = end + 1;
        }
        assert.equal(next, n, `n=${n} max=${max}: covers exactly n`);
        assert.equal(r.length, Math.ceil(n / max));
    }
    assert.equal(chunkRanges(GRID.n).length, 7, '2592 / 400 → 7 requests');
    assert.throws(() => chunkRanges(-1), RangeError);
    assert.throws(() => chunkRanges(10, 0), RangeError);
});

// ── The merged order is the OLD layout, bit for bit ──────────────────────────
ok('merging 400-location chunks reproduces the 864-location layout exactly', () => {
    const viaOld = chunkRanges(GRID.n, 864).map(({ start, end }) => gridChunkCoords(start, end));
    const viaNew = chunkRanges(GRID.n, MAX_LOCATIONS_PER_REQUEST).map(({ start, end }) => gridChunkCoords(start, end));
    const flatten = (parts) => ({
        lats: mergeChunks(parts.map(p => p.lats), GRID.n),
        lons: mergeChunks(parts.map(p => p.lons), GRID.n),
    });
    const a = flatten(viaOld), b = flatten(viaNew);
    assert.deepEqual(b.lats, a.lats);
    assert.deepEqual(b.lons, a.lons);
    // And both are the direct enumeration of the grid.
    for (let idx = 0; idx < GRID.n; idx++) {
        const { lat, lon } = gridLatLon(idx);
        assert.equal(Number(b.lats[idx]), lat);
        assert.equal(Number(b.lons[idx]), lon);
    }
    // Per-item merge order is preserved for arbitrary payloads too.
    const parts = chunkRanges(2592, 400).map(({ start, end }) =>
        Array.from({ length: end - start + 1 }, (_, k) => ({ idx: start + k })));
    const merged = mergeChunks(parts, 2592);
    merged.forEach((it, k) => assert.equal(it.idx, k));
    assert.throws(() => mergeChunks([parts[0]], 2592), /merged length/);
    assert.throws(() => mergeChunks([null], 0), /not an array/);
});

// ── formatCoord ──────────────────────────────────────────────────────────────
ok('formatCoord is %g: shortest round-trip, no padding, no −0', () => {
    assert.equal(formatCoord(-87.5), '-87.5');
    assert.equal(formatCoord(12.5), '12.5');
    assert.equal(formatCoord(0), '0');
    assert.equal(formatCoord(-0), '0');
    assert.equal(formatCoord(-0.0000001), '0');
    assert.equal(formatCoord(37.125), '37.125');
    assert.equal(formatCoord(-122.375), '-122.375');
    assert.equal(formatCoord(1 / 3), '0.333333', 'capped at six decimals');
    assert.throws(() => formatCoord(NaN), RangeError);
    // toFixed(2) on the half-degree grid was padding: "12.50" vs "12.5".
    assert.ok(formatCoord(12.5).length < (12.5).toFixed(2).length);
});

// ── URL byte ceiling, every caller ───────────────────────────────────────────
const CRON_QUERY = 'current=temperature_2m,relative_humidity_2m,pressure_msl,wind_speed_10m,wind_direction_10m,'
    + 'cloud_cover_low,cloud_cover_mid,cloud_cover_high,precipitation&wind_speed_unit=ms&timezone=UTC&models=gfs_seamless'
    + '&apikey=' + 'k'.repeat(48);
const FORECAST_QUERY = 'hourly=temperature_2m,relative_humidity_2m,pressure_msl,wind_speed_10m,wind_direction_10m,'
    + 'cloud_cover_low,cloud_cover_mid,cloud_cover_high,precipitation&wind_speed_unit=ms&timezone=UTC&forecast_days=16'
    + '&start_hour=2026-10-26T13:00&end_hour=2026-11-09T12:00';
const LEVEL_QUERY = 'hourly=temperature_850hPa,temperature_500hPa,wind_speed_850hPa,wind_direction_850hPa,'
    + 'wind_speed_500hPa,wind_direction_500hPa,cape,freezing_level_height,wind_speed_250hPa,wind_direction_250hPa'
    + '&wind_speed_unit=ms&timezone=UTC&start_hour=2026-10-25T13:00&end_hour=2026-10-29T13:00';

ok('every 5°-grid chunk URL (cron with apikey + model, forecast ring, level feed) is < MAX_URL_BYTES', () => {
    let worst = 0;
    for (const { start, end } of chunkRanges(GRID.n)) {
        const { lats, lons } = gridChunkCoords(start, end);
        for (const [base, query] of [
            [OPEN_METEO_CUSTOMER_URL, CRON_QUERY], [OPEN_METEO_FORECAST_URL, FORECAST_QUERY], [OPEN_METEO_FORECAST_URL, LEVEL_QUERY],
        ]) {
            const url = chunkUrl({ base, lats, lons, query });
            const b = byteLength(url);
            worst = Math.max(worst, b);
            assert.ok(b < MAX_URL_BYTES, `${b} B`);
        }
    }
    console.log(`      worst 5°-grid URL: ${worst} B (ceiling ${MAX_URL_BYTES})`);
    assert.ok(worst < 6000, 'headroom: the half-degree grid at 400 locations should sit near 5.4 KB');
});

ok('the OLD 864-location layout is refused by chunkUrl (the 414 that caused the outage)', () => {
    const { start, end } = chunkRanges(GRID.n, 864)[0];
    const { lats, lons } = gridChunkCoords(start, end);
    assert.throws(() => chunkUrl({ lats, lons, query: CRON_QUERY }), /exceeds MAX_URL_BYTES/);
    // And with the padded toFixed(2) coordinates the old feeds used, worse still.
    const padded = { lats: lats.map(v => Number(v).toFixed(2)), lons: lons.map(v => Number(v).toFixed(2)) };
    assert.throws(() => chunkUrl({ ...padded, query: FORECAST_QUERY }), /exceeds MAX_URL_BYTES/);
});

ok('chunkUrl validates its inputs', () => {
    assert.throws(() => chunkUrl({ lats: [], lons: [], query: '' }), RangeError);
    assert.throws(() => chunkUrl({ lats: ['1'], lons: [], query: '' }), RangeError);
    const u = chunkUrl({ lats: ['-87.5', '-82.5'], lons: ['-177.5', '-177.5'], query: 'current=temperature_2m' });
    assert.equal(u, `${OPEN_METEO_FORECAST_URL}?latitude=-87.5,-82.5&longitude=-177.5,-177.5&current=temperature_2m`);
    assert.equal(chunkUrl({ lats: ['1'], lons: ['2'] }), `${OPEN_METEO_FORECAST_URL}?latitude=1&longitude=2`, 'no query → no trailing &');
});

// ── The regional patch sizes its own chunk from its own bytes ────────────────
ok('locationsPerRequest derives the chunk from measured coordinate bytes, capped at 400', () => {
    assert.equal(locationsPerRequest({ coordBytes: 14, queryBytes: 300 }), MAX_LOCATIONS_PER_REQUEST, 'half-degree grid hits the cap');
    const fine = locationsPerRequest({ coordBytes: 17, queryBytes: 300 });
    assert.ok(fine < MAX_LOCATIONS_PER_REQUEST && fine * 17 + 300 <= MAX_URL_BYTES, `fine grid: ${fine}`);
    assert.equal(locationsPerRequest({ coordBytes: 10_000 }), 1, 'never zero');
    assert.throws(() => locationsPerRequest({ coordBytes: 0 }), RangeError);
    assert.equal(maxCoordBytes(['-37.125', '1'], ['-122.375', '2']), 7 + 8 + 2);
});

ok('the worst-case regional patch (64×64 at 0.25°, SW quadrant) emits only URLs < MAX_URL_BYTES, in cell order', () => {
    const grids = [
        { w: 64, h: 64, step: 0.25, latMin: -45.25, lonMin: -130.25 },   // "-37.125" / "-122.375"
        { w: 64, h: 64, step: 0.25, latMin: -89, lonMin: -179 },         // crosses nothing, longest lats
        { w: 64, h: 64, step: 0.25, latMin: 30, lonMin: 170 },           // wraps the antimeridian
        { w: 40, h: 64, step: 1.0,  latMin: -20, lonMin: -60 },
        { w: 1,  h: 1,  step: 0.5,  latMin: 0,   lonMin: 0 },
    ];
    for (const g of grids) {
        const { lats, lons, chunks, query, perRequest } = planPatchRequests(g);
        const N = g.w * g.h;
        assert.equal(lats.length, N); assert.equal(lons.length, N);
        assert.ok(perRequest >= 1 && perRequest <= MAX_LOCATIONS_PER_REQUEST);
        let next = 0, worst = 0;
        for (const { start, end } of chunks) {
            assert.equal(start, next); next = end + 1;
            const url = chunkUrl({ lats: lats.slice(start, end + 1), lons: lons.slice(start, end + 1), query });
            worst = Math.max(worst, byteLength(url));
        }
        assert.equal(next, N, 'chunks cover every cell, in order');
        assert.ok(worst < MAX_URL_BYTES, `patch ${JSON.stringify(g)}: ${worst} B`);
        assert.match(query, /pressure_msl/);
        for (const s of lons) assert.ok(Number(s) >= -180 && Number(s) < 180, `lon ${s} normalised`);
    }
    // Lossless at the snapped steps: no toFixed padding, no float noise.
    const { lats } = planPatchRequests({ w: 2, h: 2, step: 0.25, latMin: 37, lonMin: -122.5 });
    assert.deepEqual(lats, ['37.125', '37.125', '37.375', '37.375']);
});

// ── Pacing ───────────────────────────────────────────────────────────────────
ok('requestWeight: every location counts; >10 variables or >14 days count more', () => {
    assert.equal(requestWeight(400), 400);
    assert.equal(requestWeight(400, { variables: 9 }), 400, '≤10 variables is weight 1 per location');
    assert.equal(requestWeight(400, { variables: 20 }), 800);
    assert.ok(Math.abs(requestWeight(10, { variables: 10, days: 16 }) - 10 * 16 / 14) < 1e-12);
    assert.equal(requestWeight(0), 0);
    assert.throws(() => requestWeight(-1), RangeError);
});

ok('pacedChunkPlan (cron default): 5 windows of ≤520, 10 chunks ≤400, grid order, ≤248 s', () => {
    assert.ok(DEFAULT_PACE.budget < FREE_TIER.perMinute);
    assert.ok(DEFAULT_PACE.windowMs >= 60_000, 'a window at least a minute long');
    const plan = pacedChunkPlan({ n: GRID.n });
    assert.equal(plan.windows, Math.ceil(GRID.n / DEFAULT_PACE.budget));
    assert.equal(plan.windows, Math.ceil(GRID.n / FREE_TIER.perMinute), 'the 13 % margin costs no extra window');
    assert.equal(plan.chunks.length, 10);
    assert.equal(plan.weight, GRID.n);
    assert.equal(plan.durationMs, 4 * DEFAULT_PACE.windowMs);
    let next = 0;
    for (const c of plan.chunks) {
        assert.equal(c.start, next); next = c.end + 1;
        assert.ok(c.end - c.start + 1 <= MAX_LOCATIONS_PER_REQUEST);
        const { lats, lons } = gridChunkCoords(c.start, c.end);
        assert.ok(byteLength(chunkUrl({ lats, lons, query: 'current=a' })) < MAX_URL_BYTES);
    }
    assert.equal(next, GRID.n, 'chunks cover the grid once, in order');
    const peak = peakWindowWeight(plan.chunks, DEFAULT_PACE.windowMs);
    assert.ok(peak <= DEFAULT_PACE.budget, `peak ${peak}`);
    // Calendar-minute safety too: any 60 s window is inside some 62 s one.
    assert.ok(peakWindowWeight(plan.chunks, 60_000) <= FREE_TIER.perMinute);
});

ok('NEGATIVE CONTROL: the old 7 × 400 fan-out puts the whole grid in one minute', () => {
    const old = chunkRanges(GRID.n).map(r => ({ offsetMs: 0, weight: r.end - r.start + 1 }));
    assert.equal(old.length, 7);
    const peak = peakWindowWeight(old, 60_000);
    assert.equal(peak, 2592);
    assert.ok(peak > FREE_TIER.perMinute, 'this is what drew the minutely 429');
    // Even its first concurrent wave (3 × 400) was already over the limit.
    assert.ok(3 * 400 > FREE_TIER.perMinute);
});

ok('pacedChunkPlan: budget, weight and edge cases', () => {
    const one = pacedChunkPlan({ n: GRID.n, budget: Infinity });
    assert.equal(one.windows, 1);
    assert.equal(one.durationMs, 0);
    assert.equal(one.chunks.length, Math.ceil(GRID.n / MAX_LOCATIONS_PER_REQUEST));
    assert.ok(one.chunks.every(c => c.offsetMs === 0));
    // Weight 2 per location (e.g. 20 variables) halves the locations per window.
    const heavy = pacedChunkPlan({ n: 1000, budget: 500, windowMs: 60_000, weightPerLocation: 2 });
    assert.equal(heavy.windows, 4);
    assert.ok(peakWindowWeight(heavy.chunks, 60_000) <= 500);
    const tiny = pacedChunkPlan({ n: 3, budget: 520 });
    assert.deepEqual(tiny.chunks.map(c => [c.start, c.end, c.offsetMs]), [[0, 2, 0]]);
    assert.throws(() => pacedChunkPlan({ n: 0 }), RangeError);
    assert.throws(() => pacedChunkPlan({ n: 10, budget: 1, weightPerLocation: 2 }), RangeError);
    // Uneven n spreads evenly: no window more than one location heavier.
    const odd = pacedChunkPlan({ n: 1043, budget: 520, windowMs: 60_000 });
    const perWin = new Map();
    for (const c of odd.chunks) perWin.set(c.offsetMs, (perWin.get(c.offsetMs) || 0) + c.weight);
    const v = [...perWin.values()];
    assert.ok(Math.max(...v) - Math.min(...v) <= 1, v.join(','));
});

console.log(`\n${passed} passed`);
