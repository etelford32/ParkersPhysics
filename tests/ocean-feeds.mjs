import assert from 'node:assert/strict';
import { haversineKm } from '../api/_lib/ocean.js';
import {
    default as tidesHandler,
    normalizeStations, chooseNearestStation,
    normalizePredictions, interpolatePrediction,
} from '../api/ocean/tides.js';
import {
    default as buoysHandler,
    parseNdbcLatest, nearestNdbcStations,
} from '../api/ocean/buoys.js';
import {
    default as dartHandler,
    parseDartStations, parseDartReadings,
} from '../api/ocean/dart.js';
import { default as ensoHandler } from '../api/weather/enso-mjo.js';
import { REFERENCE_STATIONS, OCEAN_KINDS, referenceStationsPayload, unavailablePayload } from '../js/ocean-reference-stations.js';

assert.ok(Math.abs(haversineKm(0, 0, 0, 1) - 111.195) < 0.01);

const tideStations = normalizeStations([
    { id: 'lake', name: 'Lake', lat: 37.8, lng: -122.4, tidal: false },
    { id: '9414290', name: 'San Francisco', state: 'CA', lat: 37.8063, lng: -122.4659, tidal: true },
]);
assert.equal(tideStations.length, 1);
assert.equal(chooseNearestStation(tideStations, 37.8, -122.5).id, '9414290');

const curve = normalizePredictions([
    { t: '2026-08-04 12:00', v: '1.0' },
    { t: '2026-08-04 13:00', v: '2.0' },
]);
assert.equal(curve[0].time, '2026-08-04T12:00Z');
assert.equal(interpolatePrediction(curve, '2026-08-04T12:30Z'), 1.5);

const ndbc = `#STN LAT LON YYYY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES PTDY ATMP WTMP DEWP VIS TIDE
#text deg deg yr mo day hr mn degT m/s m/s m sec sec degT hPa hPa degC degC degC nmi ft
LAND1 37.806 -122.466 2026 08 04 12 10 280 6.0 8.0 MM MM MM MM 1014.2 0.3 15.1 MM 11.2 MM MM
46026 37.759 -122.833 2026 08 04 12 10 280 6.0 8.0 1.4 9 7 275 1014.2 0.3 15.1 13.8 11.2 MM MM`;
const parsed = parseNdbcLatest(ndbc);
assert.equal(parsed.length, 1, 'weather-only land stations are excluded');
assert.equal(parsed[0].wave_height_m, 1.4);
assert.equal(nearestNdbcStations(parsed, 37.8, -122.5, { limit: 1, radiusKm: 1000 })[0].id, '46026');

const dartStations = parseDartStations(`<stations>
  <station id="46407" lat="42.674" lon="-128.833" name="DART 46407" owner="NDBC" dart="y" />
  <station id="46026" lat="37.759" lon="-122.833" name="Buoy 46026" owner="NDBC" dart="n" />
</stations>`);
assert.equal(dartStations.length, 1, 'only stations explicitly marked as DART are exposed');
assert.equal(dartStations[0].id, '46407');

const dartReadings = parseDartReadings(`#YY MM DD hh mm ss T HEIGHT
2026 08 04 12 00 00 1 5273.125
2026 08 04 12 01 00 2 5273.149
2026 08 04 12 02 00 3 MM`, {
    startMs: Date.parse('2026-08-04T12:00:30Z'),
    endMs: Date.parse('2026-08-04T12:02:00Z'),
});
assert.equal(dartReadings.length, 1, 'missing heights and samples outside the requested window are removed');
assert.equal(dartReadings[0].cadence, '1-minute');
assert.equal(dartReadings[0].water_column_height_m, 5273.149);

for (const handler of [tidesHandler, buoysHandler]) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ stations: [] }), {
        headers: { 'Content-Type': 'application/json' },
    });
    const response = await handler(new Request('https://example.test/api/ocean/feed'));
    globalThis.fetch = originalFetch;
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_coordinates');
}

const invalidDart = await dartHandler(new Request('https://example.test/api/ocean/dart'));
assert.equal(invalidDart.status, 400);
assert.equal((await invalidDart.json()).error, 'invalid_station');

// ── Degraded answers (Phase 0.8): 200 + freshness:'stale', never a 503 ──────
{
    const realFetch = globalThis.fetch;
    const down = async () => { throw new Error('getaddrinfo ENOTFOUND api.tidesandcurrents.noaa.gov'); };
    const http503 = async () => new Response('busy', { status: 503 });
    try {
        for (const [kind, handler, url] of [
            ['tides', tidesHandler, 'https://example.test/api/ocean/tides?mode=stations'],
            ['buoys', buoysHandler, 'https://example.test/api/ocean/buoys?mode=stations'],
            ['dart',  dartHandler,  'https://example.test/api/ocean/dart?mode=stations'],
        ]) {
            for (const fetchStub of [down, http503]) {
                globalThis.fetch = fetchStub;
                const res = await handler(new Request(url));
                assert.equal(res.status, 200, `${kind}: a dead upstream is a degraded 200`);
                const body = await res.json();
                assert.equal(body.freshness, 'stale');
                assert.equal(body.reason, 'upstream_unavailable');
                assert.equal(body.error, undefined, 'not an error envelope — the layer keeps drawing');
                assert.equal(body.count, REFERENCE_STATIONS[kind].length);
                assert.deepEqual(body.stations.map(s => s.id), REFERENCE_STATIONS[kind].map(s => s.id), 'the ONE reference catalogue');
                assert.ok(body.stations.every(s => s.reference === true && s.fallback === true && /reference/i.test(s.name)),
                    `${kind}: every marker is flagged as a reference location`);
                assert.ok(body.stations.every(s => s.lat >= -90 && s.lat <= 90 && s.lon >= -180 && s.lon <= 180));
                assert.match(body.note, /reference locations, not observations/);
                assert.match(res.headers.get('cache-control'), /s-maxage=60/, 'degraded answers are cached briefly so recovery shows');
            }
        }
        // Point mode: available:false + reason, still 200.
        globalThis.fetch = down;
        const tide = await (await tidesHandler(new Request('https://example.test/api/ocean/tides?lat=37.8&lon=-122.5'))).json();
        assert.equal(tide.available, false); assert.equal(tide.freshness, 'stale'); assert.equal(tide.reason, 'upstream_unavailable');
        const buoy = await (await buoysHandler(new Request('https://example.test/api/ocean/buoys?lat=37.8&lon=-122.5'))).json();
        assert.equal(buoy.available, false); assert.equal(buoy.freshness, 'stale'); assert.deepEqual(buoy.stations, []);
        const dart = await (await dartHandler(new Request('https://example.test/api/ocean/dart?station=46407'))).json();
        assert.equal(dart.available, false); assert.equal(dart.freshness, 'stale'); assert.deepEqual(dart.readings, []);
        assert.equal(dart.station.id, '46407');
        // Client errors are still the client's: 400, even with NOAA down.
        assert.equal((await tidesHandler(new Request('https://example.test/api/ocean/tides?lat=999&lon=0'))).status, 400);
        assert.equal((await dartHandler(new Request('https://example.test/api/ocean/dart?station=!!'))).status, 400);
        // A healthy catalogue says freshness: live.
        globalThis.fetch = async () => Response.json({ stations: [{ id: '9414290', name: 'SF', lat: 37.8, lng: -122.47, tidal: true }] });
        const live = await (await tidesHandler(new Request('https://example.test/api/ocean/tides?mode=stations'))).json();
        assert.equal(live.freshness, 'live'); assert.equal(live.count, 1); assert.equal(live.stations[0].reference, undefined);
        // ENSO/MJO both down → 200 + stale + null indices (js/month-outlook.js treats null as unavailable).
        globalThis.fetch = down;
        const ensoRes = await ensoHandler();
        assert.equal(ensoRes.status, 200);
        const ensoBody = await ensoRes.json();
        assert.equal(ensoBody.freshness, 'stale'); assert.equal(ensoBody.partial, true);
        assert.equal(ensoBody.enso, null); assert.equal(ensoBody.mjo, null); assert.equal(ensoBody.error, undefined);
        assert.deepEqual(ensoBody.sources, { enso: 'unavailable', mjo: 'unavailable' });
    } finally { globalThis.fetch = realFetch; }

    // The pure kernel.
    assert.deepEqual(OCEAN_KINDS, ['tides', 'buoys', 'dart']);
    assert.throws(() => referenceStationsPayload('lakes', { source: 'x', source_url: 'y' }), RangeError);
    const p = referenceStationsPayload('dart', { source: 'S', source_url: 'U', detail: 'x'.repeat(500) });
    assert.equal(p.detail.length, 300, 'upstream detail is bounded');
    assert.notEqual(p.stations[0], REFERENCE_STATIONS.dart[0], 'payload copies, never hands out the frozen catalogue');
    const u = unavailablePayload({ source: 'S', detail: 'd', extra: { station: { id: 'x' } } });
    assert.equal(u.available, false); assert.equal(u.station.id, 'x'); assert.equal(u.freshness, 'stale');
}

console.log('ocean feed parsers + degraded answers: ok');
