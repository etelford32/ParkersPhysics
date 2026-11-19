/**
 * quake-worker.js — the ray tracing for the live view, off the main thread
 * (~1.5 s per source depth, measured; on the main thread it froze the stage on
 * every selection). Pure kernels only; the fan comes back by TRANSFER.
 *
 *   { type: 'select', id, quake, site } → arrivals at the site, the rays to it, the wavefront fan
 *   { type: 'list',   id, quakes, site } → each quake's first P-type arrival (nearest depth bin, ≈)
 */
import { travelTimeTable } from './phases.js';
import { arrivalsAt, buildFan, rayToSite, quickFirstArrival } from './quake-model.js';

self.onmessage = (e) => {
    const { type, id } = e.data;
    try {
        if (type === 'list') {
            const { quakes, site } = e.data;
            const rows = quakes.map((q) => ({ id: q.id, ...quickFirstArrival(q, site) }));
            self.postMessage({ type, id, ok: true, rows });
            return;
        }
        const { quake, site } = e.data;
        const table = travelTimeTable(quake.depthKm);
        const arr = arrivalsAt(quake, site, table);
        const rays = arr.rows.map((r) => ({ phase: r.phase, path: rayToSite(r, quake) }));
        const fan = buildFan(table, quake.depthKm);
        const buffers = fan.flatMap((b) => b.rays.map((r) => r.buffer));
        self.postMessage({ type, id, ok: true, arrivals: arr, rays, fan }, buffers);
    } catch (err) {
        self.postMessage({ type, id, ok: false, error: String(err?.message ?? err) });
    }
};
