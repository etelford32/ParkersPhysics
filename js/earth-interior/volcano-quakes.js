/**
 * volcano-quakes.js — the join between the live earthquake feed and the
 * volcano catalogue (PURE: no DOM, no fetch, no ambient time).
 *
 * Every volcano number comes from js/volcano-engine.js (status, the live
 * alert join, eruption odds, great-circle distance); every quake from the
 * USGS feed quake-model.js parses. This module only answers two questions,
 * and the answer to both is a PROXIMITY flag, never a claim that an
 * earthquake is volcanic — that needs a waveform, a depth trend and an
 * observatory's judgement, none of which a catalogue join has:
 *
 *   · which volcano is a quake NEAR?  — the nearest Holocene volcano (status
 *     group active or dormant) within NEAR_KM at the surface, and only for a
 *     hypocentre shallower than NEAR_DEPTH_KM (volcano-tectonic swarms are
 *     crustal; a 200 km-deep slab event under an arc is "under" a volcano in
 *     map view only);
 *   · which quakes are near a volcano? — the same rule run the other way.
 *
 * NEAR_KM is 30 km, the radius volcano observatories commonly draw around an
 * edifice for proximal seismicity; it is a disclosed screening choice, not a
 * physical boundary.
 */
import { haversineKm, groupOf } from '../volcano-engine.js';

export const NEAR_KM = 30;
export const NEAR_DEPTH_KM = 40;
const HOLOCENE_GROUPS = new Set(['active', 'dormant']);

const isHolocene = (v) => HOLOCENE_GROUPS.has(groupOf(v.status));
const shallowEnough = (q) => !(Number.isFinite(q.depthKm) && q.depthKm > NEAR_DEPTH_KM);

/** The nearest Holocene volcano within NEAR_KM of a quake's epicentre: { volcano, km, live } | null. */
export function volcanoNearQuake(quake, volcanoes, live = new Map(), { km = NEAR_KM } = {}) {
    if (!quake || !Number.isFinite(quake.lat) || !Number.isFinite(quake.lon) || !shallowEnough(quake)) return null;
    let best = null, bestD = Infinity;
    for (const v of volcanoes ?? []) {
        if (!isHolocene(v)) continue;
        if (Math.abs(v.lat - quake.lat) > km / 100) continue;            // cheap latitude reject (1° ≈ 111 km)
        const d = haversineKm(quake.lat, quake.lon, v.lat, v.lon);
        if (d < bestD) { bestD = d; best = v; }
    }
    return best && bestD <= km ? { volcano: best, km: bestD, live: live.get(best.i) ?? null } : null;
}

/** Quakes within NEAR_KM of a volcano (shallow ones only), newest first: [{ quake, km }]. */
export function quakesNearVolcano(volcano, quakes, { km = NEAR_KM } = {}) {
    if (!volcano) return [];
    const out = [];
    for (const q of quakes ?? []) {
        if (!Number.isFinite(q.lat) || !shallowEnough(q)) continue;
        const d = haversineKm(volcano.lat, volcano.lon, q.lat, q.lon);
        if (d <= km) out.push({ quake: q, km: d });
    }
    return out.sort((a, b) => b.quake.timeMs - a.quake.timeMs);
}

const CC_RANK = { RED: 3, ORANGE: 2, YELLOW: 1, GREEN: 0 };
/**
 * The volcanoes the live feed lists today (the engine's `matchActivity` map),
 * most serious first: aviation colour code, then an open EONET event, then name.
 * Each row carries how many feed quakes sit within NEAR_KM.
 */
export function liveVolcanoRows(live, quakes = []) {
    const rows = [];
    for (const r of live?.values?.() ?? []) {
        const since = (r.items ?? []).filter((i) => i.source === 'eonet' && i.startedAt).map((i) => i.startedAt).sort()[0] ?? null;
        rows.push({
            volcano: r.volcano, colorCode: r.colorCode ?? null, alertLevel: r.alertLevel ?? null,
            sources: [...new Set((r.items ?? []).map((i) => (i.source === 'usgs-hans' ? 'USGS' : 'NASA EONET')))],
            openSince: since, nearbyQuakes: quakesNearVolcano(r.volcano, quakes).length,
        });
    }
    return rows.sort((a, b) => (CC_RANK[b.colorCode] ?? -1) - (CC_RANK[a.colorCode] ?? -1)
        || (b.nearbyQuakes - a.nearbyQuakes) || a.volcano.name.localeCompare(b.volcano.name));
}
