// storms-feed.mjs — contract tests for the global tropical-cyclone feed.
//
// The thing under test is mostly the HONESTY of the payload. /api/storms
// merges two upstreams that cover disjoint halves of the planet, and until
// 2026-09 all three of these rendered identically (200, count:0, a fresh
// `updated` stamp):
//
//   - both feeds answered and the tropics really are quiet
//   - one feed died, so half the world is unobserved
//   - both feeds died, so the empty list is not an observation at all
//
// That ambiguity is what the "storm watch panel isn't showing up" report
// actually was: the panel printed "No active tropical cyclones worldwide
// right now" over a feed that had returned nothing, and status.html scored
// the outage green. These tests pin the three states apart.
//
// Parsing tests double as a guard on the NHC field-name scar documented in
// api/_lib/storms.js — a parser reading `lat`/`lon` instead of
// `latitudeNumeric`/`longitudeNumeric` drops every storm silently.

import assert from 'node:assert/strict';
import {
    parseNHCStorms, parseEONETStorms, mergeStorms, assessFeed,
    buildStormsPayload, parseCoord, eonetBasin, classifyEONETTitle,
    BASIN_COVERAGE, EONET_MAX_AGE_MS,
} from '../api/_lib/storms.js';

const NOW = Date.parse('2026-09-16T12:00:00Z');
const ok  = data => ({ ok: true, data });
const dead = error => ({ ok: false, error });

// ── Upstream fixtures ────────────────────────────────────────────────────
const NHC_FEED = {
    activeStorms: [
        {
            id: 'al072026', name: 'HURRICANE IMELDA', classification: 'HU',
            latitudeNumeric: 24.6, longitudeNumeric: -71.2,
            latitude: '24.6N', longitude: '71.2W',
            intensity: '95', pressure: '958',
            movementDir: 315, movementSpeed: 12,
            lastUpdate: '2026-09-16T09:00:00Z',
        },
        {
            id: 'ep112026', name: 'TROPICAL STORM NARDA', classification: 'TS',
            latitudeNumeric: 16.1, longitudeNumeric: -108.4,
            intensity: '45', pressure: '1000',
            movementDir: 290, movementSpeed: 9,
        },
    ],
};

const EONET_FEED = {
    events: [{
        id: 'EONET_6621', title: 'Super Typhoon Ragasa',
        sources: [{ url: 'https://www.metoc.navy.mil/jtwc/products/wp1826.tcw' }],
        geometry: [
            { type: 'Point', date: '2026-09-16T00:00:00Z', coordinates: [131.0, 18.0], magnitudeValue: 120 },
            { type: 'Point', date: '2026-09-16T06:00:00Z', coordinates: [130.0, 19.0], magnitudeValue: 130 },
        ],
    }],
};

// ── Parsing ──────────────────────────────────────────────────────────────
{
    const storms = parseNHCStorms(NHC_FEED);
    assert.equal(storms.length, 2, 'both NHC storms survive the parser');
    const [imelda] = storms;
    assert.equal(imelda.basin, 'ATLANTIC');          // from the al… id prefix
    assert.equal(imelda.lat, 24.6);
    assert.equal(imelda.lon, -71.2);
    assert.equal(imelda.intensityKt, 95);
    assert.equal(imelda.pressureHpa, 958);
    assert.equal(imelda.hemisphere, 'N');
    assert.equal(storms[1].basin, 'EPAC');
    // The scar: the string forms must also work when the numerics are absent.
    const fallback = parseNHCStorms({ activeStorms: [{
        id: 'al082026', name: 'X', classification: 'TS',
        latitude: '15.4N', longitude: '40.0W', intensity: '40',
    }] });
    assert.equal(fallback[0].lat, 15.4);
    assert.equal(fallback[0].lon, -40);
    // Garbage in must not throw or fabricate.
    assert.deepEqual(parseNHCStorms(null), []);
    assert.deepEqual(parseNHCStorms({ activeStorms: 'nope' }), []);
    assert.equal(parseCoord('113.5W'), -113.5);
    assert.equal(parseCoord('nonsense'), null);
}

{
    const storms = parseEONETStorms(EONET_FEED, NOW);
    assert.equal(storms.length, 1);
    assert.equal(storms[0].basin, 'WPAC');           // from the wp… product URL
    assert.equal(storms[0].classification, 'STY');
    assert.equal(storms[0].name, 'Ragasa');
    assert.equal(storms[0].intensityKt, 130);        // newest point wins
    assert.equal(storms[0].pressureHpa, null);       // EONET carries no pressure
    assert.ok(storms[0].movementKt > 0, 'movement derived from the last two points');

    // A dissipated system EONET forgot to close must drop out.
    const old = parseEONETStorms(EONET_FEED, NOW + EONET_MAX_AGE_MS + 3600e3);
    assert.equal(old.length, 0, 'track older than the age cap is dropped');

    assert.equal(classifyEONETTitle('Cyclone Freddy').classification, 'TC');
    assert.equal(eonetBasin([], -20, 60), 'SH', 'southern latitude → SH');
    assert.deepEqual(parseEONETStorms({ events: null }, NOW), []);
}

// ── Merge: NHC wins on overlap ───────────────────────────────────────────
{
    const nhc   = parseNHCStorms(NHC_FEED);
    const eonet = parseEONETStorms(EONET_FEED, NOW);
    const merged = mergeStorms(nhc, eonet);
    assert.equal(merged.length, 3);
    assert.equal(merged[0].intensityKt, 130, 'sorted by intensity desc');

    // Same storm from both feeds → one entry, and it is the NHC one.
    const dupEonet = [{ ...eonet[0], name: 'Imelda', lat: 24.6, lon: -71.2 }];
    const dedup = mergeStorms(nhc, dupEonet);
    assert.equal(dedup.length, 2, 'positional duplicate collapses');
    assert.ok(dedup.every(s => s.name !== 'Imelda' || s.source === 'nhc'));
}

// ── Feed health — the three claims ───────────────────────────────────────
{
    const live = assessFeed({ ok: true }, { ok: true });
    assert.equal(live.freshness, 'live');
    assert.equal(live.coverage, 1);
    assert.deepEqual(live.missingBasins, []);
    assert.equal(live.note, null, 'a healthy feed says nothing');

    const bothDown = assessFeed({ ok: false }, { ok: false });
    assert.equal(bothDown.freshness, 'stale');
    assert.equal(bothDown.coverage, 0);
    assert.deepEqual(
        bothDown.missingBasins,
        [...BASIN_COVERAGE.nhc, ...BASIN_COVERAGE.eonet],
        'every basin is unobserved when both upstreams are down');
    assert.match(bothDown.note, /not because no storms are active/i,
        'the payload itself must deny the absence claim');

    // NHC down → the Atlantic is invisible even though EONET answered.
    const nhcDown = assessFeed({ ok: false }, { ok: true });
    assert.equal(nhcDown.freshness, 'degraded');
    assert.equal(nhcDown.coverage, 0.5);
    assert.deepEqual(nhcDown.missingBasins, [...BASIN_COVERAGE.nhc]);
    assert.match(nhcDown.note, /NOAA NHC is unreachable/);
    assert.match(nhcDown.note, /Atlantic, East Pacific and Central Pacific/);

    // EONET down → no typhoons, which is the more dangerous silence.
    const eonetDown = assessFeed({ ok: true }, { ok: false });
    assert.equal(eonetDown.freshness, 'degraded');
    assert.deepEqual(eonetDown.missingBasins, [...BASIN_COVERAGE.eonet]);
    assert.match(eonetDown.note, /NASA EONET is unreachable/);
    assert.match(eonetDown.note, /West Pacific, Indian Ocean and Southern Hemisphere/);
}

// ── Whole payload ────────────────────────────────────────────────────────
{
    const healthy = buildStormsPayload(ok(NHC_FEED), ok(EONET_FEED), NOW);
    assert.equal(healthy.freshness, 'live');
    assert.equal(healthy.count, 3);
    assert.equal(healthy.updated, new Date(NOW).toISOString());
    assert.equal(healthy.sources.nhc.count, 2);
    assert.equal(healthy.sources.eonet.count, 1);
    assert.ok(!('note' in healthy), 'no note on a healthy payload');

    // THE REGRESSION. Both upstreams dead: still a 200-shaped body with an
    // empty list, but it can never again be mistaken for a quiet ocean.
    const outage = buildStormsPayload(dead('timeout after 8000ms'), dead('HTTP 503'), NOW);
    assert.equal(outage.count, 0);
    assert.equal(outage.freshness, 'stale');
    assert.equal(outage.coverage, 0);
    assert.deepEqual(outage.storms, []);
    assert.equal(outage.sources.nhc.ok, false);
    assert.equal(outage.sources.nhc.error, 'timeout after 8000ms');
    assert.equal(outage.sources.eonet.error, 'HTTP 503');
    assert.ok(outage.note, 'an outage must carry its reason');

    // Partial: a REAL list that is nonetheless incomplete. The count is
    // honest about what was found; freshness is honest about what wasn't.
    const partial = buildStormsPayload(ok(NHC_FEED), dead('HTTP 500'), NOW);
    assert.equal(partial.freshness, 'degraded');
    assert.equal(partial.count, 2, 'the NHC storms are still served');
    assert.deepEqual(partial.missingBasins, [...BASIN_COVERAGE.eonet]);

    // A "quiet ocean" payload — both feeds answered, nothing active. This
    // is the ONLY state in which count:0 is an actual observation.
    const quiet = buildStormsPayload(ok({ activeStorms: [] }), ok({ events: [] }), NOW);
    assert.equal(quiet.count, 0);
    assert.equal(quiet.freshness, 'live');
    assert.equal(quiet.coverage, 1);
    assert.ok(!('note' in quiet));
    // …and it must be distinguishable from the outage by freshness alone,
    // since that is all status.html and the panel get to look at.
    assert.notEqual(quiet.freshness, outage.freshness);
}

console.log('storms-feed: parsing, merge, and the three freshness claims passed');
