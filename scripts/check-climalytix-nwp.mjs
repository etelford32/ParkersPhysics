#!/usr/bin/env node
// scripts/check-climalytix-nwp.mjs — is the SITE serving the GFS run the
// ingest just published?
//
// The worker's own read-back (scripts/climalytix_ingest/gfs.py) proves the run
// is in the bucket the WORKER writes. This proves the other half: that
// /api/climalytix/nwp — Vercel's credentials, Vercel's bucket — reads it. The
// two can disagree (different R2_BUCKET or account on the two sides), and from
// 2026-11-10 to 2026-11-16 nothing checked either: the workflow was green and
// the page said "no GFS run has been ingested yet".
//
//   node scripts/check-climalytix-nwp.mjs [--base https://www.parkersphysics.com]
//        [--expect-run 2026-11-16T00:00Z] [--wait-s 780]
//
// The rule is checkNwpProbe (js/climalytix/point-tile.js, gated by
// tests/climalytix-nwp-route.mjs). An OLDER run than --expect-run is retried
// for --wait-s: an isolate caches the manifest for 10 minutes. Exit 1 on a
// problem, 2 when the route is unreachable.

import { checkNwpProbe } from '../js/climalytix/point-tile.js';

const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const base = arg('--base', 'https://www.parkersphysics.com').replace(/\/$/, '');
const expectRun = arg('--expect-run', null);
const deadline = Date.now() + Number(arg('--wait-s', '780')) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let last = { problems: ['never probed'], retry: true };
let unreachable = false;
for (let attempt = 1; ; attempt += 1) {
    // Cache-buster: a fresh answer is CDN-cached 30 min by URL.
    const url = `${base}/api/climalytix/nwp?lat=40.00&lon=-105.25&probe=${Date.now()}`;
    try {
        const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'parkersphysics-climalytix-probe' },
            signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        unreachable = false;
        last = checkNwpProbe(body, { expectRun });
        console.log(`attempt ${attempt}: run ${body.run ?? '—'}  freshness ${body.freshness ?? '—'}  `
            + `age ${body.age_seconds != null ? `${Math.round(body.age_seconds / 3600)} h` : '—'}  ${body.reasons?.join(', ') ?? ''}`);
    } catch (e) {
        unreachable = true;
        last = { problems: [`${base} unreachable — ${e?.message ?? e}`], retry: true };
        console.log(`attempt ${attempt}: ${last.problems[0]}`);
    }
    if (!last.problems.length || !last.retry || Date.now() + 45_000 > deadline) break;
    await sleep(45_000);
}

if (last.problems.length) {
    for (const p of last.problems) console.error(`::error title=Climalytix archive not served::${p}`);
    process.exit(unreachable ? 2 : 1);
}
console.log(`climalytix probe: production is serving ${expectRun ?? 'a fresh run'}`);
