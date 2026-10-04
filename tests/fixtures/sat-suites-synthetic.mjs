/**
 * sat-suites-synthetic.mjs — a SYNTHETIC CelesTrak catalogue for the
 * upper-atmosphere satellite-suite gates (CelesTrak is egress-blocked at
 * build time, and a gate must not depend on today's catalogue anyway).
 *
 * Real, checksummed TLE lines (so the committed SGP4 WASM parses them like
 * any live record) plus the normalised OMM fields the route also emits, for
 * Walker-like suites: a Starlink-ish 53° shell, a GPS-ish 6-plane MEO set, a
 * GEO belt and one ISS-like station. Epoch = `epochMs` so the propagation
 * span stays short whatever day the gate runs.
 */

const MU = 398600.8, RE = 6378.135;

const checksum = (l) => {
    let c = 0;
    for (const ch of l.slice(0, 68)) c += ch === '-' ? 1 : (ch >= '0' && ch <= '9' ? Number(ch) : 0);
    return l.slice(0, 68) + (c % 10);
};
const f = (v, w, d) => v.toFixed(d).padStart(w, ' ');

function tle({ norad, incDeg, raanDeg, ecc, argpDeg, mDeg, nRevDay, epochMs }) {
    const d = new Date(epochMs);
    const y = d.getUTCFullYear();
    const doy = (epochMs - Date.UTC(y, 0, 1)) / 86400000 + 1;
    const id = String(norad).padStart(5, '0');
    const l1 = `1 ${id}U 26001A   ${String(y % 100).padStart(2, '0')}${f(doy, 12, 8).replace(/ /g, '0')}  .00000000  00000-0  00000-0 0  999`;
    const l2 = `2 ${id} ${f(incDeg, 8, 4)} ${f(((raanDeg % 360) + 360) % 360, 8, 4)} ${ecc.toFixed(7).slice(2)} ${f(argpDeg, 8, 4)} ${f(((mDeg % 360) + 360) % 360, 8, 4)} ${f(nRevDay, 11, 8)}    1`;
    return [checksum(l1.padEnd(68, ' ')), checksum(l2.padEnd(68, ' '))];
}

const nForAlt = (altKm) => Math.sqrt(MU / (RE + altKm) ** 3) * 86400 / (2 * Math.PI);

function rec(o) {
    const [line1, line2] = tle(o);
    return {
        name: o.name, norad_id: o.norad, line1, line2,
        epoch: new Date(o.epochMs).toISOString(), epoch_jd: o.epochMs / 86400000 + 2440587.5,
        inclination: o.incDeg, raan: ((o.raanDeg % 360) + 360) % 360, eccentricity: o.ecc,
        arg_perigee: o.argpDeg, mean_anomaly: ((o.mDeg % 360) + 360) % 360, mean_motion: o.nRevDay, bstar: 0,
    };
}

export function syntheticCatalogue(epochMs) {
    const groups = { starlink: [], 'gps-ops': [], geo: [], stations: [] };
    let norad = 70000;
    for (let p = 0; p < 6; p++) for (let k = 0; k < 8; k++) {
        groups.starlink.push(rec({ name: `STARLINK-SYN ${p}-${k}`, norad: norad++, incDeg: 53, raanDeg: p * 60,
            ecc: 0.0001, argpDeg: 90, mDeg: k * 45 + p * 7.5, nRevDay: nForAlt(550), epochMs }));
    }
    for (let p = 0; p < 6; p++) for (let k = 0; k < 4; k++) {
        groups['gps-ops'].push(rec({ name: `GPS-SYN ${p}-${k}`, norad: norad++, incDeg: 55, raanDeg: p * 60 + 15,
            ecc: 0.005, argpDeg: 30, mDeg: k * 90 + p * 15, nRevDay: 2.00563, epochMs }));
    }
    for (let k = 0; k < 8; k++) {
        groups.geo.push(rec({ name: `GEO-SYN ${k}`, norad: norad++, incDeg: 0.05, raanDeg: 80,
            ecc: 0.0002, argpDeg: 0, mDeg: k * 45, nRevDay: 1.00273, epochMs }));
    }
    groups.stations.push(rec({ name: 'STATION-SYN', norad: 79999, incDeg: 51.64, raanDeg: 120,
        ecc: 0.0005, argpDeg: 60, mDeg: 10, nRevDay: nForAlt(420), epochMs }));
    return groups;
}

/** Route /api/celestrak/tle?group=… to the synthetic catalogue (unknown groups → 503 with an error). */
export async function routeSyntheticCatalogue(page, epochMs) {
    const cat = syntheticCatalogue(epochMs);
    await page.route('**/api/celestrak/tle**', (route) => {
        const g = new URL(route.request().url()).searchParams.get('group');
        const sats = cat[g];
        if (!sats) {
            return route.fulfill({ status: 503, contentType: 'application/json',
                body: JSON.stringify({ error: 'fixture has no such group', group: g }) });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
            satellites: sats, source: 'synthetic fixture', source_format: 'tle', fetched: new Date(epochMs).toISOString(),
        }) });
    });
    return cat;
}
