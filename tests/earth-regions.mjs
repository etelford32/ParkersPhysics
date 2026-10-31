/**
 * earth-regions.mjs — named regions as camera poses, and the LOD readout's words
 * ═══════════════════════════════════════════════════════════════════════════
 * Pins js/earth-regions.js (PURE). The framing is checked against the SAME
 * footprint geometry js/focus-footprint.js uses to switch the regional
 * layers on, so "Go to a region" is proved to land in regional detail, not
 * just near the region. The browser half is tests/earth-regional-lod.spec.js.
 *
 * Run: node tests/earth-regions.mjs
 */
import assert from 'node:assert/strict';
import {
    regionList, regionById, regionFromBox, regionView, standoffForArc, parseAtParam,
    viewTier, groundKmPerPx, formatAltitude, formatScale, slugify, VIEW_TIERS, POLAR_VIEW_LAT,
} from '../js/earth-regions.js';
import { REGIONS } from '../js/geo-regions.js';
import { REGIONAL_DETAIL } from '../js/cloud-mosaic-core.js';

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const DEG = Math.PI / 180;

// ── 1. One table: every REGIONS box, once, addressable ─────────────────────
const list = regionList();
ok(list.length === REGIONS.length, 'every REGIONS box is a region (and nothing else is)');
ok(new Set(list.map(r => r.id)).size === list.length, 'ids are unique');
for (const r of list) {
    ok(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(r.id), `id is a url slug (${r.id})`);
    ok(regionById(r.id) === r && regionById(r.name) === r, `lookup by id and by name (${r.name})`);
    ok(Math.abs(r.lat) <= 90 && r.lon >= -180 && r.lon < 180, `centre in range (${r.name})`);
    ok(r.latSpan > 0 && r.lonSpan > 0, `spans positive (${r.name})`);
}
ok(regionById('nowhere') === null && regionById(undefined) === null, 'unknown id → null');
ok(slugify('Mexico & US Southwest') === 'mexico-and-us-southwest', 'ampersand reads "and"');
{
    const np = regionFromBox([30, 62, 140, -120, 'North Pacific']);
    ok(np.lonSpan === 100 && Math.abs(np.lon - (-170)) < 1e-9, 'a box across the antimeridian centres on the dateline side');
    const arctic = regionById('arctic');
    ok(arctic.polar && arctic.lat === POLAR_VIEW_LAT, 'a full-longitude band is framed from just off its pole');
    ok(POLAR_VIEW_LAT < 90, 'never ON the pole: OrbitControls orbits the polar axis');
    ok(regionById('antarctica').lat === -POLAR_VIEW_LAT, 'south too');
}

// ── 2. The framing identity ────────────────────────────────────────────────
// d = cos θ + sin θ / tan α ⇔ the arc's edge subtends exactly α.
for (const thetaDeg of [2, 10, 25, 50]) {
    for (const halfFov of [15, 20, 30]) {
        const t = thetaDeg * DEG, ta = Math.tan(halfFov * DEG);
        const d = standoffForArc(t, ta);
        const subtended = Math.atan2(Math.sin(t), d - Math.cos(t));
        ok(Math.abs(subtended - halfFov * DEG) < 1e-9, `arc ${thetaDeg}° fills a ${halfFov}° half-fov exactly`);
    }
}

// ── 3. Every region lands in REGIONAL DETAIL with the box on screen ───────
// focus-footprint's footprint half-angle at distance d: min(horizon, frustum)
// with frustum = (d − 1)·tan(fov/2), × its 1.25 overscan.
const footprintSpanLatDeg = (d, fovDeg) => {
    const horizon = Math.acos(1 / d);
    const frustum = (d - 1) * Math.tan((fovDeg * DEG) / 2);
    return 2 * Math.min(horizon, frustum) * 1.25 / DEG;
};
for (const aspect of [16 / 9, 4 / 3, 0.5]) {               // desktop, laptop, phone portrait
    let regional = 0;
    for (const r of list) {
        const v = regionView(r, { fovDeg: 40, aspect });
        // The whole box is inside the frustum on both axes.
        const tv = Math.tan(20 * DEG), th = tv * aspect;
        const coslat = r.polar ? 1 : Math.cos(r.lat * DEG);
        const thV = (r.latSpan / 2) * DEG, thH = (r.lonSpan / 2) * coslat * DEG;
        const sub = (t) => Math.atan2(Math.sin(t), v.dist - Math.cos(t));
        if (v.dist < 4.2) {
            ok(sub(thV) <= Math.atan(tv) + 1e-9 && sub(thH) <= Math.atan(th) + 1e-9, `${r.name} fits on screen at aspect ${aspect.toFixed(2)}`);
        }
        const isRegional = footprintSpanLatDeg(v.dist, 40) <= REGIONAL_DETAIL.activateSpanDeg;
        if (isRegional) regional++;
        // Every LAND region lands in regional detail on a 16:9 screen; the
        // ocean basins and polar caps are wider than a regional view by
        // nature and are framed whole instead.
        if (aspect > 1.7 && r.group !== 'Seas & oceans' && r.group !== 'Polar') {
            ok(isRegional, `${r.name} lands in regional detail at 16:9`);
        }
    }
    if (aspect > 1) ok(regional / list.length >= 0.7, `≥ 70 % of all regions land in regional detail at aspect ${aspect.toFixed(2)} (${regional}/${list.length})`);
}
{
    const v = regionView(regionById('us-great-plains-and-midwest'), { fovDeg: 40, aspect: 16 / 9 });
    ok(footprintSpanLatDeg(v.dist, 40) <= 32, `the Great Plains view also turns the 0.25° weather patch on (span ${footprintSpanLatDeg(v.dist, 40).toFixed(1)}°)`);
    const phone = regionView(regionById('us-great-plains-and-midwest'), { fovDeg: 40, aspect: 0.5 });
    ok(phone.dist > v.dist, 'a portrait phone stands farther off (the horizontal fov binds)');
    ok(regionView({ lat: 0, lon: 0, latSpan: 0.1, lonSpan: 0.1 }, { minDist: 1.02 }).dist === 1.02, 'clamped to the floor');
    ok(regionView({ lat: 0, lon: 0, latSpan: 60, lonSpan: 90 }, { maxDist: 1.5 }).dist === 1.5, 'clamped to the ceiling');
    const huge = regionView({ lat: 0, lon: 0, latSpan: 170, lonSpan: 300 });
    ok(Number.isFinite(huge.dist) && huge.dist <= 4.2, 'an arc past the visible hemisphere still gets a finite, bounded stand-off');
}

// ── 4. Deep links ──────────────────────────────────────────────────────────
{
    const a = parseAtParam('40,-95,1500');
    ok(a && a.lat === 40 && a.lon === -95 && Math.abs((a.dist - 1) * 6371 - 1500) < 1e-6, '?at=lat,lon,altKm');
    ok(Math.abs((parseAtParam('10,20').dist - 1) * 6371 - 1500) < 1e-6, 'altitude defaults to a regional 1500 km');
    ok(parseAtParam('10,190').lon === -170, 'longitude wrapped');
    ok(parseAtParam('95,0') === null && parseAtParam('x,y') === null && parseAtParam(null) === null && parseAtParam('5') === null, 'bad input → null');
    ok(parseAtParam('0,0,1', { minDist: 1.004 }).dist === 1.004, 'clamped to the camera floor');
}

// ── 5. The readout's words and numbers ─────────────────────────────────────
ok(VIEW_TIERS.find(t => t.id === 'regional').maxSpanDeg === REGIONAL_DETAIL.activateSpanDeg,
    '"Regional detail" is the regional window\'s OWN activation span — one number');
ok(viewTier(90).id === 'global' && viewTier(45).id === 'regional' && viewTier(30).id === 'regional' && viewTier(12).id === 'local' && viewTier(NaN).id === 'global', 'tiers by footprint span');
ok(Math.abs(groundKmPerPx(1 + 720 / 6371, 40, 720) - 2 * 720 * Math.tan(20 * DEG) / 720) < 1e-9, 'km per pixel at nadir');
ok(formatAltitude(1240) === '1.2 Mm' && formatAltitude(38.4) === '38 km' && formatAltitude(NaN) === '—', 'altitude strings (the HUD\'s format)');
ok(formatScale(2.13) === '2.1 km/px' && formatScale(0.35) === '350 m/px' && formatScale(23.6) === '24 km/px' && formatScale(0) === '—', 'scale strings');

console.log(`earth-regions: ${n} assertions passed`);
