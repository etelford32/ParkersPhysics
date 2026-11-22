#!/usr/bin/env node
/**
 * serve-local-r2.mjs — a READ-ONLY, path-style S3 stand-in over a local
 * directory, for running the R2-backed routes against a local ingest.
 *
 *   python3 scripts/climalytix_ingest/gfs.py --max-lead 48 --out /tmp/cx
 *   node scripts/serve-local-r2.mjs /tmp/cx            # prints the env line
 *   R2_… node dev-server.mjs
 *
 * It ignores signatures, serves GET/HEAD with Range, binds 127.0.0.1 only and
 * refuses paths outside the directory. Development and captures only — it is
 * not the archive, and nothing in production may point at it.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '');
const port = Number(process.argv[3]) || 9100;
if (!process.argv[2] || !fs.existsSync(root)) {
    console.error('usage: node scripts/serve-local-r2.mjs <dir> [port]');
    process.exit(2);
}

http.createServer((req, res) => {
    const parts = decodeURIComponent(new URL(req.url, 'http://x').pathname).split('/').filter(Boolean);
    const file = path.resolve(root, ...parts.slice(1));          // parts[0] is the bucket
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404); return res.end('NoSuchKey');
    }
    const size = fs.statSync(file).size;
    if (req.method === 'HEAD') { res.writeHead(200, { 'content-length': size }); return res.end(); }
    const m = /bytes=(\d+)-(\d+)?/.exec(req.headers.range || '');
    if (!m) { res.writeHead(200, { 'content-length': size }); return fs.createReadStream(file).pipe(res); }
    const start = Number(m[1]);
    const end = Math.min(m[2] ? Number(m[2]) : size - 1, size - 1);
    if (start > end) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}` });
    fs.createReadStream(file, { start, end }).pipe(res);
}).listen(port, '127.0.0.1', () => {
    console.log(`local R2 stand-in: ${root} on http://127.0.0.1:${port}`);
    console.log(`R2_ACCOUNT_ID=local R2_ACCESS_KEY_ID=local R2_SECRET_ACCESS_KEY=local R2_BUCKET=local R2_ENDPOINT=http://127.0.0.1:${port}`);
});
