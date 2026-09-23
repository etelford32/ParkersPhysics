/**
 * tests/helpers/cloud-source.mjs — where the cloud gates get their pixels.
 *
 * ONE switch, three modes, so the same assertions can run against the real
 * world, against real archived imagery with no network, or against the
 * synthetic stubs CI has always used:
 *
 *   live       CLOUD_LIVE=1. No routes are stubbed: NASA GIBS and the
 *              weather API are hit for real (on the dev server, or on
 *              production via TEST_BASE_URL=https://parkersphysics.com).
 *              tests/cloud-live.spec.js is the gate for this mode.
 *   fixture    tests/fixtures/clouds/manifest.json exists — written by
 *              `node scripts/fetch-cloud-fixtures.mjs` on a machine that can
 *              reach earthdata.nasa.gov. GIBS requests are answered from disk
 *              with the REAL frame nearest the requested layer + time, and
 *              /api/weather/grid with the saved live grid, so the run is
 *              egress-free but every pixel is an observation.
 *   synthetic  neither of the above (the build sandbox). Banded IR + a
 *              transparent MODIS COT, encoded here.
 *
 * Also carries a minimal PNG encoder / decoder (Node has no canvas; 60
 * lines beat a native dependency) and the disc statistics the live gate
 * measures on screenshots.
 */
import zlib from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT        = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURE_DIR = join(ROOT, 'tests', 'fixtures', 'clouds');
export const MANIFEST    = join(FIXTURE_DIR, 'manifest.json');

// ── PNG encode (RGBA, no interlace) ─────────────────────────────────────────
function crc32(buf) {
    let c, table = crc32.table;
    if (!table) {
        table = crc32.table = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            table[n] = c;
        }
    }
    c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}
export function encodePng(width, height, rgbaFn) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 6;
    const raw = Buffer.alloc(height * (1 + width * 4));
    for (let j = 0; j < height; j++) {
        const row = j * (1 + width * 4);
        raw[row] = 0;
        for (let i = 0; i < width; i++) {
            const [r, g, b, a] = rgbaFn(i, j);
            const o = row + 1 + i * 4;
            raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
        }
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

// ── PNG decode (8-bit RGB / RGBA, non-interlaced — what Playwright writes) ──
export function decodePng(buf) {
    if (buf.readUInt32BE(0) !== 0x89504E47) throw new Error('not a PNG');
    let pos = 8, width = 0, height = 0, colorType = 6, bitDepth = 8, interlace = 0;
    const idat = [];
    while (pos < buf.length) {
        const len  = buf.readUInt32BE(pos);
        const type = buf.toString('ascii', pos + 4, pos + 8);
        const data = buf.subarray(pos + 8, pos + 8 + len);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0); height = data.readUInt32BE(4);
            bitDepth = data[8]; colorType = data[9]; interlace = data[12];
        } else if (type === 'IDAT') idat.push(data);
        else if (type === 'IEND') break;
        pos += 12 + len;
    }
    if (bitDepth !== 8 || interlace !== 0 || (colorType !== 6 && colorType !== 2)) {
        throw new Error(`decodePng: unsupported PNG (depth ${bitDepth}, type ${colorType}, interlace ${interlace})`);
    }
    const ch  = colorType === 6 ? 4 : 3;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * ch;
    const out = new Uint8Array(width * height * 4);
    const prev = new Uint8Array(stride);
    const cur  = new Uint8Array(stride);
    let ip = 0;
    for (let y = 0; y < height; y++) {
        const filter = raw[ip++];
        for (let x = 0; x < stride; x++) {
            const a = x >= ch ? cur[x - ch] : 0;
            const b = prev[x];
            const c = x >= ch ? prev[x - ch] : 0;
            let v = raw[ip++];
            switch (filter) {
                case 1: v += a; break;
                case 2: v += b; break;
                case 3: v += (a + b) >> 1; break;
                case 4: {
                    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                    v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
                    break;
                }
            }
            cur[x] = v & 255;
        }
        for (let x = 0; x < width; x++) {
            const o = (y * width + x) * 4, s = x * ch;
            out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2];
            out[o + 3] = ch === 4 ? cur[s + 3] : 255;
        }
        prev.set(cur);
    }
    return { width, height, data: out };
}

// ── Screenshot statistics ───────────────────────────────────────────────────
/** Mean luminance + "white-ish" (bright, unsaturated) fraction over a rect. */
export function rectStats(img, rect) {
    const { x0, y0, x1, y1 } = rect;
    let lumSum = 0, n = 0, cloudy = 0;
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            const o = (y * img.width + x) * 4;
            const r = img.data[o], g = img.data[o + 1], b = img.data[o + 2];
            const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
            const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
            const sat = mx > 0 ? (mx - mn) / mx : 0;
            lumSum += lum; n++;
            if (lum > 0.55 && sat < 0.25) cloudy++;
        }
    }
    return { meanLum: lumSum / n, cloudFrac: cloudy / n, pixels: n };
}
/** Mean absolute RGB difference (0–255) over a rect. */
export function rectDiff(a, b, rect) {
    const { x0, y0, x1, y1 } = rect;
    let sum = 0, n = 0;
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            const o = (y * a.width + x) * 4;
            sum += Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1]) + Math.abs(a.data[o + 2] - b.data[o + 2]);
            n += 3;
        }
    }
    return sum / n;
}
/** Centre box of a viewport — inside the globe's disc at the default framing. */
export function discRect(width, height, frac = 0.36) {
    const hw = Math.round(width * frac / 2), hh = Math.round(height * frac / 2);
    return { x0: width / 2 - hw, y0: height / 2 - hh, x1: width / 2 + hw, y1: height / 2 + hh };
}

// ── Synthetic stubs (the sandbox path) ──────────────────────────────────────
// Banded IR (alternating overcast / clear stripes) so the mosaic carries
// structure; MODIS COT transparent (observed-clear).
export const SYNTHETIC_IR  = encodePng(64, 32, (i) => ((i >> 3) & 1) ? [235, 235, 235, 255] : [70, 70, 70, 255]);
export const SYNTHETIC_COT = encodePng(64, 32, () => [0, 0, 0, 0]);

// ── Source resolution ───────────────────────────────────────────────────────
export function resolveCloudSource() {
    if (process.env.CLOUD_LIVE === '1') return { mode: 'live', manifest: null };
    if (existsSync(MANIFEST)) {
        try {
            const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
            if (Array.isArray(manifest.frames) && manifest.frames.length) return { mode: 'fixture', manifest };
        } catch { /* fall through to synthetic */ }
    }
    return { mode: 'synthetic', manifest: null };
}

/** Nearest fixture for a GIBS request: same layer id, closest time. */
export function pickFixture(manifest, layerId, timeStr) {
    const cands = manifest.frames.filter(f => f.layerId === layerId);
    if (!cands.length) return null;
    const t = Date.parse(timeStr.includes('T') ? timeStr : `${timeStr}T12:00:00Z`);
    let best = null, bestD = Infinity;
    for (const f of cands) {
        const d = Math.abs((f.timestampMs ?? Date.parse(f.time)) - t);
        if (d < bestD) { bestD = d; best = f; }
    }
    // A fixture from a different day is not "the frame at that time".
    return bestD <= 12 * 3_600_000 ? best : null;
}

/**
 * Install the routes for a source mode. Returns the request log (every
 * GIBS request: { layers, time, at, served }).
 */
export async function installCloudRoutes(page, source) {
    const log = [];
    if (source.mode === 'live') {
        page.on('request', req => {
            const u = req.url();
            if (!u.includes('wvs.earthdata.nasa.gov')) return;
            const url = new URL(u);
            log.push({ layers: url.searchParams.get('LAYERS') ?? '', time: url.searchParams.get('TIME') ?? '', at: Date.now(), served: 'network' });
        });
        return log;
    }
    await page.route('**wvs.earthdata.nasa.gov/**', async route => {
        const url    = new URL(route.request().url());
        const layers = url.searchParams.get('LAYERS') ?? '';
        const time   = url.searchParams.get('TIME') ?? '';
        let body = null, served = 'synthetic';
        if (source.mode === 'fixture') {
            const f = pickFixture(source.manifest, layers, time);
            if (f) { body = readFileSync(join(FIXTURE_DIR, f.file)); served = f.file; }
            else   { log.push({ layers, time, at: Date.now(), served: 'miss' }); await route.fulfill({ status: 404, body: '' }); return; }
        } else {
            body = /Cloud_Optical_Thickness/.test(layers) ? SYNTHETIC_COT : SYNTHETIC_IR;
        }
        log.push({ layers, time, at: Date.now(), served });
        await route.fulfill({ status: 200, contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body });
    });
    // Real wind for the advection in fixture mode: the saved live grid,
    // single-frame for both the live and the `?since=` range shapes.
    if (source.mode === 'fixture' && source.manifest.weatherGrid) {
        const gridPath = join(FIXTURE_DIR, source.manifest.weatherGrid);
        if (existsSync(gridPath)) {
            const frame = JSON.parse(readFileSync(gridPath, 'utf8'));
            await page.route('**/api/weather/grid*', async route => {
                const url = new URL(route.request().url());
                const body = url.searchParams.has('since')
                    ? { since: url.searchParams.get('since'), count: 1, frames: [frame] }
                    : frame;
                await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
            });
        }
    }
    return log;
}
