#!/usr/bin/env node
/**
 * scripts/build-glacier-summary.mjs — the small per-glacier summary EarthView's Glaciers
 * layer loads (data/glaciers/summary.json).
 *
 * WHY A SUMMARY: the layer marks every glacier with its motion state, and that state needs
 * the glacier's PAIRS — ~190 KB of detail file each, ~4.8 MB for 25 glaciers, which an
 * EarthView layer must not cost. Calling /api/glaciers/velocity 25 times would make the
 * server download dozens of granules per visitor. So the state is computed HERE, by the
 * same engine the page uses (js/glacier-engine.js: gauges, gaugeRecord, currentState,
 * detectable), from the committed archive, and stamped `as_of` — the layer prints that date
 * and deep-links to glacier-watch.html for today's pairs. Re-run after every archive bake.
 *
 * DERIVED, never hand-edited: `--check` recomputes from data/glaciers/* and fails on drift;
 * tests/glacier-engine.mjs runs the same comparison.
 *
 * Usage: node scripts/build-glacier-summary.mjs [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as E from '../js/glacier-engine.js';

const DIR = new URL('../data/glaciers/', import.meta.url);
const read = (f) => JSON.parse(readFileSync(new URL(f, DIR), 'utf8'));
const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const r0 = (v) => (Number.isFinite(v) ? Math.round(v) : null);
const day = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null);

/** PURE: index JSON + { id: detail JSON } + mass-balance JSON → the summary object. */
export function buildSummary(indexJson, detailsById, mbJson) {
    const glaciers = E.decodeIndex(indexJson);
    const out = [];
    for (const g of glaciers) {
        const det = E.decodeDetail(detailsById[g.id]);
        E.attachDetail(g, det);
        const asOfMs = g.bakedMs + 864e5 - 1;                 // end of the bake day: no pair in the archive is later
        const gs = E.gauges(g);
        const mid = gs.find(q => q.id === 'middle');
        const gaugeRows = gs.filter(q => q.id !== 'fastest').map(q => {
            const det_ = E.detectable(g, q.idx);
            const rec = E.gaugeRecord(g, det.pairs, q.idx);
            const st = E.currentState(rec, asOfMs, { detect: det_ });
            return { id: q.id, label: q.label, state: st.state, text: st.label, pct: r1(st.pct), n: st.n,
                     v_latest: r0(st.latest?.v), latest_end: day(st.latest?.d2), v0: r0(det_.v0) };
        });
        const v0 = Array.from(g.climatology.v0).filter(Number.isFinite);
        const newest = det.pairs.reduce((a, p) => (!a || p.d2 > a.d2 ? p : a), null);
        const mb = mbJson?.glaciers?.[g.id] || null;
        const mbRows = mb ? mb.rows.filter(r => r.annual !== null) : [];
        const cum = E.latestRun(E.cumulativeBalance(mbRows));   // never a sum across a gap
        out.push({
            id: g.id, name: g.name, region: g.region, country: g.country, kind: g.kind,
            as_of: day(g.bakedMs),                            // this glacier's own bake: a refresh that failed for it keeps its older date
            // the marker sits ON the ice: the mid-glacier gauge's flowline point
            lat: g.flowline.lat[mid.idx], lon: g.flowline.lon[mid.idx],
            flowline_km: r1(g.flowline.length_m / 1000),
            v0_max: r0(v0.length ? Math.max(...v0) : NaN),
            pairs_year: det.pairs.length, pairs_30d: det.pairs.filter(p => p.mid >= asOfMs - 30 * 864e5).length,
            newest_pair_end: day(newest?.d2),
            gauges: gaugeRows,
            mass_balance: mb ? { starts: mb.starts, ends: mb.ends, last: mbRows.at(-1)?.annual ?? null, cumulative: r1(cum.at(-1)?.cumulative), cumulative_since: cum[0]?.since ?? null } : null,
        });
    }
    const dates = out.map(g => g.as_of).filter(Boolean).sort();
    return {
        format: 'glacier-watch-summary-v1',
        as_of: dates.at(-1) ?? null,                          // the newest bake; the weekly refresh moves it
        as_of_oldest: dates[0] ?? null,                       // ≠ as_of only when some glacier's last refresh failed
        source: 'derived from data/glaciers/* by js/glacier-engine.js (NASA ITS_LIVE v2 pairs; WGMS mass balance)',
        note: "Motion states are as of each glacier's archive date. glacier-watch.html adds the pairs published since.",
        glaciers: out,
    };
}

function loadAll() {
    const idx = read('glaciers.json');
    const details = {};
    for (const g of idx.glaciers) details[g.id] = read(`${g.id}.json`);
    let mb = null;
    try { mb = read('massbalance.json'); } catch { /* optional */ }
    return { idx, details, mb };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const { idx, details, mb } = loadAll();
    const json = JSON.stringify(buildSummary(idx, details, mb)) + '\n';
    const out = new URL('summary.json', DIR);
    if (process.argv.includes('--check')) {
        const now = readFileSync(out, 'utf8');
        if (now !== json) { console.error('summary.json is stale — run node scripts/build-glacier-summary.mjs'); process.exit(1); }
        console.log('summary.json matches the archive');
    } else {
        writeFileSync(out, json);
        const s = JSON.parse(json);
        for (const g of s.glaciers) console.log(g.id.padEnd(19), (g.gauges.find(q => q.id === 'middle')?.state ?? '').padEnd(13), `${g.pairs_year} pairs, newest ${g.newest_pair_end}`);
        console.log(`${(json.length / 1024).toFixed(1)} KB`);
    }
}
