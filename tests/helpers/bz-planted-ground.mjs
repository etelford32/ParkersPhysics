/**
 * tests/helpers/bz-planted-ground.mjs — a PLANTED USGS network for the Bz
 * engine's ground gates. SYNTHETIC by design: the payload SHAPE is the
 * IAGA-JSON the real service returns (verified in production 2026-11-20), the
 * coordinates are approximate observatory positions used only to exercise the
 * code path that reads them from the payload, and every signal is planted so
 * its recovery can be scored.
 */
export const ROSTER = Object.freeze({
    BOU: [40.14, -105.24], BRW: [71.32, -156.62], BSL: [30.35, -89.64], CMO: [64.87, -147.86], DED: [70.36, -148.79],
    FRD: [38.20, -77.37], FRN: [37.09, -119.72], GUA: [13.59, 144.87], HON: [21.32, -158.00], NEW: [48.27, -117.12],
    SHU: [55.35, -160.46], SIT: [57.06, -135.33], SJG: [18.11, -66.15], TUC: [32.17, -110.73],
});

export function usgsPayload(id, [lat, lon], tMs, x, y, z = null) {
    const clean = (a) => Array.from(a, (v) => (v === v && v != null ? Math.round(v * 1000) / 1000 : null));
    return {
        type: 'Timeseries',
        metadata: { station: { id, name: id, geometry: { type: 'Point', coordinates: [lon < 0 ? lon + 360 : lon, lat, 0] } } },
        times: Array.from(tMs, (t) => new Date(t).toISOString()),
        values: [{ id: 'X', values: clean(x) }, { id: 'Y', values: clean(y) }, { id: 'Z', values: clean(z ?? x.map(() => 45000)) }],
    };
}

/**
 * Build both cadences for the whole roster.
 * @param {{ nowMs:number, siAtMs?:number|null, siStepNt?:number, lagS?:number, seed?:number,
 *           spikeAt?:string|null, pc5At?:string|null, bayAt?:string|null, drop?:string[] }} o
 * @returns {{ fast: Record<string,object>, slow: Record<string,object> }} raw payloads keyed by IAGA code
 */
export function plantedGround({ nowMs, siAtMs = null, siStepNt = 12, lagS = 129, seed = 3,
    spikeAt = 'CMO', pc5At = 'BOU', bayAt = 'CMO', drop = [] } = {}) {
    let a = seed >>> 0;
    const u = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const g = () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
    const end = Math.floor(nowMs / 1000) * 1000;
    const fast = {}, slow = {};
    for (const [id, pos] of Object.entries(ROSTER)) {
        if (drop.includes(id)) continue;
        const base = 20000 + 37 * id.charCodeAt(0);
        const step = (t) => (siAtMs != null && Math.abs(pos[0]) < 60 ? siStepNt / (1 + Math.exp(-(t - siAtMs) / 8000)) : 0);
        const bay = id === bayAt ? -300 : 0;
        // 1 s, the last hour; the newest `lagS` seconds have not arrived (null padding).
        const N = 3601, t = new Float64Array(N), x = new Float64Array(N), y = new Float64Array(N);
        for (let i = 0; i < N; i++) {
            t[i] = end - (N - 1 - i) * 1000;
            const pc5 = id === pc5At ? 3 * Math.sin(2 * Math.PI * 0.004 * i) : 0;
            // a 3-second burst of 2 nT/s, twenty minutes in
            const spike = id === spikeAt ? 2 * Math.min(3, Math.max(0, i - 1200)) : 0;
            x[i] = base + bay + step(t[i]) + pc5 + spike + 0.02 * g();
            y[i] = 100 + 0.02 * g();
            if (i >= N - lagS) { x[i] = NaN; y[i] = NaN; }
        }
        fast[id] = usgsPayload(id, pos, t, x, y);
        // 60 s, 24 h: quiet at `base`, with the bay only in the final two hours.
        const M = 1441, ts = new Float64Array(M), xs = new Float64Array(M), ys = new Float64Array(M);
        for (let i = 0; i < M; i++) {
            ts[i] = Math.floor(end / 60000) * 60000 - (M - 1 - i) * 60000;
            xs[i] = base + (i > M - 120 ? bay : 0) + 0.2 * g(); ys[i] = 100 + 0.2 * g();
            if (i >= M - 3) { xs[i] = NaN; ys[i] = NaN; }
        }
        slow[id] = usgsPayload(id, pos, ts, xs, ys);
    }
    return { fast, slow };
}

/** A fetch mock that serves planted USGS payloads by `id` and `sampling_period`. null = 404. */
export function usgsResponder(planted) {
    return (url) => {
        const s = String(url);
        if (!s.includes('geomag.usgs.gov')) return undefined;
        const id = /[?&]id=([A-Z]+)/.exec(s)?.[1], sp = /sampling_period=(\d+)/.exec(s)?.[1];
        const body = (sp === '1' ? planted.fast : planted.slow)[id];
        return body ? Response.json(body) : new Response('not found', { status: 404 });
    };
}
