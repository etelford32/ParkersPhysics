#!/usr/bin/env node
/**
 * scripts/probe-bz-feeds.mjs — settle the Bz engine's UNVERIFIED feeds
 * (BZ_ENGINE_PLAN.md phase B0) from any machine with open network.
 *
 *   node scripts/probe-bz-feeds.mjs                 every feed, direct to upstream
 *   node scripts/probe-bz-feeds.mjs l1-mag geo-mag  just these
 *   node scripts/probe-bz-feeds.mjs --base https://parkersphysics.com
 *                                                   ask the deployed route instead
 *   node scripts/probe-bz-feeds.mjs --save          also write the raw upstream
 *                                                   bodies to tests/fixtures/bz/
 *                                                   (REAL data — never hand-edit)
 *
 * It runs the SAME js/bz/feeds.js the route and the browser run. Record what
 * it prints in the `verified` field of FEEDS, then trim the candidate lists.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEEDS, FEED_IDS, runFeed, summarize } from '../js/bz/feeds.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const save = args.includes('--save');
const baseIdx = args.indexOf('--base');
const base = baseIdx >= 0 ? args[baseIdx + 1]?.replace(/\/$/, '') : null;
const wanted = args.filter((a, i) => !a.startsWith('--') && !(baseIdx >= 0 && i === baseIdx + 1));
const feeds = wanted.length ? wanted : FEED_IDS;

const bodies = new Map();
async function fetchJson(url) {
    try {
        const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
        const contentType = res.headers.get('content-type');
        if (!res.ok) return { ok: false, status: res.status, contentType, error: `HTTP ${res.status}` };
        const text = await res.text();
        let body;
        try { body = JSON.parse(text); } catch { return { ok: false, status: res.status, contentType, error: 'not JSON' }; }
        bodies.set(url, text);
        return { ok: true, status: res.status, contentType, body };
    } catch (e) {
        return { ok: false, status: null, error: String(e?.cause?.code ?? e?.message ?? e).slice(0, 120) };
    }
}

let anyAnswered = false;
for (const id of feeds) {
    if (!FEEDS[id]) { console.error(`unknown feed: ${id} (known: ${FEED_IDS.join(', ')})`); process.exitCode = 2; continue; }
    console.log(`\n══ ${id} — ${FEEDS[id].label}`);
    let out;
    if (base) {
        const r = await fetchJson(`${base}/api/bz/feeds?feed=${id}&meta=1`);
        if (!r.ok) { console.log(`  route: ${r.error}`); continue; }
        out = r.body;
    } else {
        out = await runFeed(id, { fetchJson, nowMs: Date.now(), meta: true });
        if (out.data) out.data = summarize(out.data);
    }
    for (const c of out.candidates) {
        console.log(`  ${c.ok ? '✓' : '✗'} ${c.id.padEnd(20)} ${String(c.http_status ?? '—').padEnd(4)} rows ${String(c.rows).padEnd(6)} ${c.error ?? ''}`);
        if (c.ok) {
            anyAnswered = true;
            const s = c.summary;
            for (const [k, v] of Object.entries(s.spacecraft ?? s.satellites ?? {})) {
                console.log(`      ${k}: n=${v.n} cadence=${v.cadence_s}s last=${v.last}`
                    + (v.active_fraction != null ? ` active=${v.active_fraction}` : '')
                    + (v.unit_inferred ? ` unit=${v.unit_inferred} r=${JSON.stringify(v.last_re)}` : '')
                    + (v.arcjet_flagged != null ? ` arcjet=${v.arcjet_flagged}` : ''));
            }
            if (s.overlap_minutes != null) console.log(`      two-spacecraft overlap: ${s.overlap_minutes} min · frames ${JSON.stringify(s.frames)} · active ${s.active_spacecraft}`);
            if (s.separation_re) console.log(`      separation (R_E): ${JSON.stringify(s.separation_re)}`);
            if (s.latency_s != null) console.log(`      cadence=${s.cadence_s}s completeness=${s.completeness} latency=${s.latency_s}s elements=${JSON.stringify(s.elements)}`);
            if (s.field_map) console.log(`      field_map: ${JSON.stringify(s.field_map)}`);
            if (s.unmapped?.length) console.log(`      unmapped: ${s.unmapped.join(', ')}`);
        }
    }
    console.log(`  → source ${out.source_id ?? 'NONE'} · freshness ${out.freshness}${out.reasons?.length ? ' · ' + out.reasons.join(', ') : ''}`);
}

if (save && !base) {
    const dir = join(ROOT, 'tests', 'fixtures', 'bz');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    for (const [url, text] of bodies) {
        const name = url.replace(/^https?:\/\//, '').replace(/[?#].*$/, '').replace(/[^a-z0-9.]+/gi, '_').replace(/_?\.json$/, '') + `-${stamp}.json`;
        writeFileSync(join(dir, name), text);
        console.log(`saved tests/fixtures/bz/${name}`);
    }
}
if (!anyAnswered) { console.log('\nNo candidate answered — is this machine egress-blocked?'); process.exitCode ||= 1; }
