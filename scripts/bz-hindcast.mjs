#!/usr/bin/env node
/**
 * scripts/bz-hindcast.mjs — run the Bz engine's archive hindcast (BZ_ENGINE_PLAN.md §20).
 *
 *   node scripts/bz-hindcast.mjs            # read data/bz/l1-dst-archive.json.gz, write data/bz/hindcast-dst.json
 *   node scripts/bz-hindcast.mjs --check    # recompute and fail if the committed result differs
 *
 * The archive file is REAL production data (public.sw_geomag_dataset through
 * /api/ring-current/dataset) — never hand-edit it; re-pull and re-bake. The result is
 * deterministic (seeded bootstrap), so --check is an exact comparison.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hindcastDst, HINDCAST_DEFAULTS } from '../js/bz/hindcast.js';

const path = (p) => fileURLToPath(new URL(p, import.meta.url));
export function loadArchive() {
    const raw = gunzipSync(readFileSync(path('../data/bz/l1-dst-archive.json.gz')));
    const a = JSON.parse(raw);
    return { sha256: createHash('sha256').update(raw).digest('hex'), meta: { source: a.source, t0: a.t0, minutes: a.minutes },
        archive: { t0Ms: Date.parse(a.t0), stepMs: a.step_s * 1000, speed: a.speed_kms, density: a.density_cc, bz: a.bz_gsm_nt,
            dst: a.dst.map(([h, v]) => [Date.parse(`${h}:00:00Z`), v]) } };
}
const round = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);
const tidy = (o) => (Array.isArray(o) ? o.map(tidy) : (o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, tidy(v)])) : round(o)));

export function build() {
    const { sha256, meta, archive } = loadArchive();
    const r = hindcastDst(archive);
    const endMs = archive.t0Ms + (archive.bz.length - 1) * archive.stepMs;
    return {
        model: 'bz-hindcast-dst-v0',
        what: 'the ring-current rung of the Bz engine (O\'Brien–McPherron Dst driven by arrived L1 wind) against observed hourly Dst, beside persistence',
        archive: { ...meta, sha256, from: new Date(archive.t0Ms).toISOString(), to: new Date(endMs).toISOString(), days: Math.round((endMs - archive.t0Ms) / 86400e3) },
        settings: { window_h: HINDCAST_DEFAULTS.windowH, stride_h: HINDCAST_DEFAULTS.strideH, leads_h: HINDCAST_DEFAULTS.leadsH, disturbed_dst_nt: HINDCAST_DEFAULTS.disturbedDstNt,
            bootstrap: `${HINDCAST_DEFAULTS.bootstrapN} resamples of whole UTC days, seed ${HINDCAST_DEFAULTS.seed}`, verdict: 'ahead/behind only when the whole 95 % interval is on one side of zero' },
        not_hindcast: ['L1 fusion and tilted-front delay (the archive has one L1 stream)', 'geosynchronous filter (no GOES magnetometer history is archived)'],
        ...tidy(r),
    };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const out = `${JSON.stringify(build(), null, 1)}\n`, file = path('../data/bz/hindcast-dst.json');
    if (process.argv.includes('--check')) {
        if (readFileSync(file, 'utf8') !== out) { console.error('data/bz/hindcast-dst.json is stale — run node scripts/bz-hindcast.mjs'); process.exit(1); }
        console.log('hindcast result matches the archive');
    } else {
        writeFileSync(file, out);
        const r = JSON.parse(out);
        for (const [k, d] of Object.entries(r.drivers)) {
            console.log(`\n${k} — ${d.windows} windows (${d.disturbed_windows} disturbed)`);
            for (const set of ['all', 'disturbed', 'quiet']) console.log(`  ${set.padEnd(9)} ` + Object.entries(d[set]).map(([L, s]) => `${L}h ${s.skill == null ? '—' : s.skill.toFixed(2)}${s.skill_ci95 ? `[${s.skill_ci95[0].toFixed(2)},${s.skill_ci95[1].toFixed(2)}]` : ''} ${s.verdict[0]}`).join(' | '));
        }
        console.log('\nrmse (measured/stamp, all):', Object.entries(r.drivers['measured/stamp'].all).map(([L, s]) => `${L}h ${s.rmse_nt} vs ${s.rmse_persistence_nt} (bias ${s.bias_nt})`).join(' | '));
        console.log('skipped', r.skipped, 'wind', r.wind, 'dst', r.dst);
    }
}
