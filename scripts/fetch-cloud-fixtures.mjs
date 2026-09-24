#!/usr/bin/env node
/**
 * scripts/fetch-cloud-fixtures.mjs — pull REAL cloud imagery for the cloud
 * gates, and measure how far back the GIBS archive reaches. Run on a machine
 * that can reach earthdata.nasa.gov — the build sandbox cannot.
 *
 *   node scripts/fetch-cloud-fixtures.mjs [--res=1024] [--leads=0,3,6]
 *                                         [--api=https://parkersphysics.com]
 *                                         [--probe] [--probe-only]
 *
 * Writes tests/fixtures/clouds/:
 *   <layer>@<time>.png   one frame per geostationary region (primary IR
 *                        layer) and the MODIS COT polar fill, at each lead
 *                        (hours before the newest publishable frame)
 *   weather-grid.json    the live /api/weather/grid frame (real wind for
 *                        the advection; skipped if the API is unreachable)
 *   manifest.json        what was fetched, with real timestamps
 *   archive-probe.json   (--probe) which leads the archive still serves
 *
 * With a manifest present, tests/helpers/cloud-source.mjs switches the
 * cloud gates to FIXTURE mode: every GIBS request is answered from disk
 * with the real frame nearest the requested layer + time, egress-free.
 *
 * --probe walks one IR layer back in time (1 h … 60 d) at thumbnail size
 * and reports the oldest lead that still returns an image. That number
 * SETTLES the retention assumption in js/cloud-time.js (MOSAIC.retentionMs)
 * — record it there. `ok` is a heuristic: HTTP 200 + an image content type
 * + more bytes than an empty frame compresses to (GIBS answers an
 * out-of-range time with a blank transparent PNG, not an error).
 *
 * Nothing here is imported by the site.
 */
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gibsTimeCandidates, toUtcDate } from '../js/cloud-mosaic-core.js';

export const GIBS_BASE = 'https://wvs.earthdata.nasa.gov/api/v1/snapshot';

/** Primary layer per region — mirrors GEO_REGIONS in js/cloud-imagery.js. */
export const REGION_PRIMARY = [
    { region: 'GOES-East', layerId: 'GOES-East_ABI_Band13_Clean_Infrared_Brightness_Temperature', subLon: -75.2 },
    { region: 'GOES-West', layerId: 'GOES-West_ABI_Band13_Clean_Infrared_Brightness_Temperature', subLon: -137.2 },
    { region: 'Himawari',  layerId: 'Himawari_AHI_Band13_Clean_Infrared_Brightness_Temperature',  subLon: 140.7 },
    { region: 'Meteosat',  layerId: 'Meteosat-11_IODC_Brightness_Temperature_Band_13_4',          subLon: 45.5 },
];
export const POLAR_LAYER = 'MODIS_Terra_Cloud_Optical_Thickness';

export function snapshotUrl(time, layer, width, height = width / 2) {
    const p = new URLSearchParams({
        REQUEST: 'GetSnapshot', TIME: time, BBOX: '-90,-180,90,180', CRS: 'EPSG:4326',
        LAYERS: layer, WRAP: 'day', FORMAT: 'image/png', WIDTH: String(width), HEIGHT: String(height | 0),
    });
    return `${GIBS_BASE}?${p}`;
}

/** Fetch one snapshot; resolves { ok, status, contentType, bytes, buf }. */
export async function fetchSnapshot(url, { timeoutMs = 30_000, minBytes = 2_000 } = {}) {
    const ctl = new AbortController();
    const to  = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const r = await fetch(url, { signal: ctl.signal });
        const contentType = r.headers.get('content-type') ?? '';
        const buf = Buffer.from(await r.arrayBuffer());
        const ok  = r.ok && contentType.startsWith('image/') && buf.length >= minBytes;
        return { ok, status: r.status, contentType, bytes: buf.length, buf };
    } catch (e) {
        return { ok: false, status: 0, contentType: '', bytes: 0, buf: null, error: String(e?.message ?? e) };
    } finally {
        clearTimeout(to);
    }
}

/**
 * Archive reach: try `layerId` at each lead (hours before the newest
 * publishable frame) and report which still serve an image.
 */
export async function probeArchive({
    layerId = REGION_PRIMARY[0].layerId,
    leadsHours = [1, 6, 24, 72, 168, 336, 504, 720, 1080, 1440],
    nowMs = Date.now(),
    width = 256,
    log = () => {},
} = {}) {
    const latest = gibsTimeCandidates(nowMs)[0];   // floor(now − lag) to cadence
    const results = [];
    for (const lead of leadsHours) {
        const t = latest.timestampMs - lead * 3_600_000;
        const cand = gibsTimeCandidates(t, { lagMin: 0, backMin: [0], dateFallback: false })[0];
        const url  = snapshotUrl(cand.time, layerId, width);
        const r    = await fetchSnapshot(url);
        results.push({ leadHours: lead, time: cand.time, ok: r.ok, status: r.status, contentType: r.contentType, bytes: r.bytes, error: r.error });
        log(`${String(lead).padStart(5)} h  ${cand.time}  ${r.ok ? 'OK ' : '-- '} ${r.status} ${r.contentType} ${r.bytes} B${r.error ? '  ' + r.error : ''}`);
    }
    const oldestOk = results.filter(r => r.ok).map(r => r.leadHours).sort((a, b) => b - a)[0] ?? null;
    return { probedAt: new Date(nowMs).toISOString(), layerId, results, oldestOkHours: oldestOk };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
    const arg = (name, dflt) => (process.argv.find(a => a.startsWith(`--${name}=`)) ?? `--${name}=${dflt}`).split('=').slice(1).join('=');
    const flag = (name) => process.argv.includes(`--${name}`);
    const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
    const OUT  = join(ROOT, 'tests', 'fixtures', 'clouds');
    const res   = Number(arg('res', 1024));
    const leads = arg('leads', '0,3,6').split(',').map(Number).filter(Number.isFinite);
    const api   = arg('api', 'https://parkersphysics.com').replace(/\/$/, '');
    mkdirSync(OUT, { recursive: true });

    if (flag('probe') || flag('probe-only')) {
        console.log(`Archive reach probe (${REGION_PRIMARY[0].region} IR, ${256}px):`);
        const probe = await probeArchive({ log: console.log });
        writeFileSync(join(OUT, 'archive-probe.json'), JSON.stringify(probe, null, 2) + '\n');
        console.log(probe.oldestOkHours == null
            ? 'No lead returned an image — is earthdata.nasa.gov reachable?'
            : `Oldest lead still served: ${probe.oldestOkHours} h (${(probe.oldestOkHours / 24).toFixed(1)} d). ` +
              `Record it in js/cloud-time.js MOSAIC.retentionMs.`);
        if (flag('probe-only')) process.exit(0);
    }

    const now    = Date.now();
    const latest = gibsTimeCandidates(now)[0];
    const manifest = { synthetic: false, fetched: new Date(now).toISOString(), res, leadsHours: leads, frames: [], weatherGrid: null };
    let total = 0;
    for (const lead of leads) {
        const t = latest.timestampMs - lead * 3_600_000;
        const cands = gibsTimeCandidates(t, { lagMin: 0, backMin: [0, 10, 30], dateFallback: false });
        for (const reg of REGION_PRIMARY) {
            let hit = null;
            for (const c of cands) {
                const r = await fetchSnapshot(snapshotUrl(c.time, reg.layerId, res));
                if (r.ok) { hit = { ...c, ...r }; break; }
                console.log(`  ${reg.region} @ ${c.time}: ${r.status} ${r.contentType} ${r.bytes} B — trying older`);
            }
            if (!hit) { console.error(`${reg.region} −${lead} h: no frame`); continue; }
            const file = `${reg.region}@${hit.time.replace(/:/g, '')}.png`;
            writeFileSync(join(OUT, file), hit.buf);
            total += hit.bytes;
            manifest.frames.push({ region: reg.region, layerId: reg.layerId, subLon: reg.subLon, kind: 'ir',
                                   leadHours: lead, time: hit.time, timestampMs: hit.timestampMs, file, bytes: hit.bytes });
            console.log(`wrote ${file} (${hit.bytes} B)`);
        }
        // Polar fill is a daily composite: today walking back, once per lead-day.
        const day = toUtcDate(t);
        if (!manifest.frames.some(f => f.layerId === POLAR_LAYER && f.time === day)) {
            let hit = null;
            for (let back = 0; back <= 3 && !hit; back++) {
                const d = toUtcDate(t - back * 86_400_000);
                const r = await fetchSnapshot(snapshotUrl(d, POLAR_LAYER, res), { minBytes: 500 });
                if (r.ok) hit = { time: d, ...r };
            }
            if (hit) {
                const file = `Polar@${hit.time}.png`;
                writeFileSync(join(OUT, file), hit.buf);
                total += hit.bytes;
                manifest.frames.push({ region: 'Polar', layerId: POLAR_LAYER, subLon: null, kind: 'cot',
                                       leadHours: lead, time: hit.time, timestampMs: null, file, bytes: hit.bytes });
                console.log(`wrote ${file} (${hit.bytes} B)`);
            }
        }
    }

    // The live weather grid — real wind for the advection.
    try {
        const r = await fetch(`${api}/api/weather/grid`);
        if (r.ok) {
            const json = await r.json();
            writeFileSync(join(OUT, 'weather-grid.json'), JSON.stringify(json));
            manifest.weatherGrid = 'weather-grid.json';
            total += statSync(join(OUT, 'weather-grid.json')).size;
            console.log(`wrote weather-grid.json (${json.source ?? 'unknown source'}, age ${json.age_seconds ?? '?'} s)`);
        } else {
            console.error(`weather grid: HTTP ${r.status} from ${api}`);
        }
    } catch (e) {
        console.error(`weather grid: ${e?.message ?? e}`);
    }

    writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log(`manifest.json: ${manifest.frames.length} frames, ${(total / 1e6).toFixed(1)} MB on disk. ` +
                `Cloud gates now run in FIXTURE mode (real imagery, no network).`);
}
