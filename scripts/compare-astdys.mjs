#!/usr/bin/env node
/**
 * scripts/compare-astdys.mjs — validate our frequency-analysed proper
 * elements against AstDyS's synthetic proper elements.
 *
 *   node scripts/compare-astdys.mjs <trojans-analysis.csv> <astdys.json> [--out data/trojans/astdys-comparison.json]
 *
 * <astdys.json> is a saved /api/trojans/proper body. Matching is by
 * designation with spaces removed (AstDyS "2001QR322" = SBDB "2001 QR322").
 *
 * AstDyS rows where ITS OWN fit failed are excluded and counted, never
 * silently compared: f < F_MIN (a failed libration fit), D ≤ 0 (published
 * negative/zero amplitudes), and g below GT5_LOCK ″/yr — a "free" g sitting
 * on Jupiter's own g5 (4.25″/yr) means the forced line was taken as free.
 * Our withheld elements (span too short) are simply absent from that column.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { normaliseDesignation } from '../api/_lib/astdys-proper.js';
import { orbitQuality } from '../js/trojan-dynamics.js';

const GT5_LOCK = 20;   // ″/yr
/**
 * AstDyS rows with f below this (°/yr) are fit failures, not slow librators:
 * the 2026-11-03 file has f values of 0.006–0.26 where our run measures the
 * physical ~2.45 (small-amplitude theory 2.43), while AstDyS's own 1st
 * percentile of f is 1.92. Excluded and counted.
 */
const F_MIN = 1.5;

function readCsv(file) {
    const text = readFileSync(file, 'utf8').trim().split('\n');
    const head = text[0].split(',');
    const parse = (line) => { const out = []; let cur = '', q = false;
        for (let i = 0; i < line.length; i++) { const ch = line[i];
            if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
            else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; }
        out.push(cur); return out; };
    return text.slice(1).map(l => { const c = parse(l); return Object.fromEntries(head.map((h, k) => [h, c[k]])); });
}
const num = (v) => (v === '' || v == null ? null : Number(v));
const arg = (n, d) => { const k = process.argv.indexOf(`--${n}`); return k > 0 ? process.argv[k + 1] : d; };

export function stats(pairs) {
    const d = pairs.map(([o, a]) => o - a).sort((x, y) => x - y);
    const ad = d.map(Math.abs).sort((x, y) => x - y);
    const q = (xs, p) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : null);
    const n = pairs.length;
    const mo = pairs.reduce((s, [o]) => s + o, 0) / n, ma = pairs.reduce((s, [, a]) => s + a, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (const [o, a] of pairs) { sxy += (o - mo) * (a - ma); sxx += (o - mo) ** 2; syy += (a - ma) ** 2; }
    return { n, median_diff: q(d, 0.5), median_abs: q(ad, 0.5), p90_abs: q(ad, 0.9), p99_abs: q(ad, 0.99),
        correlation: n > 2 ? sxy / Math.sqrt(sxx * syy) : null };
}

function main() {
    const [csvFile, astFile] = process.argv.slice(2);
    if (!csvFile || !astFile) { console.error('usage: compare-astdys.mjs <analysis.csv> <astdys.json> [--out file]'); process.exit(2); }
    const out = arg('out', 'data/trojans/astdys-comparison.json');
    const ours = readCsv(csvFile);
    const body = JSON.parse(readFileSync(astFile, 'utf8'));
    const col = Object.fromEntries(body.columns.map((c, k) => [c, k]));
    const ast = new Map(body.rows.map(r => [r[col.des], Object.fromEntries(body.columns.map((c, k) => [c, r[k]]))]));

    const excluded = { f_below_1_5_deg_yr: 0, D_nonpositive: 0, g_locked_to_g5: 0 };
    const pairs = { D: [], da: [], f: [], e: [], g: [], sinI: [], s: [] };
    const byQuality = {};
    // AstDyS integrates most Trojans for 5 Myr and some for 50 Myr (the 'My'
    // column); measured 2026-11-03, 13 of the 14 largest D disagreements are
    // 50-Myr rows (26 % of the file) — the harder, likelier-chaotic orbits,
    // whose proper elements are least stable. The split says how much.
    const bySpan = {};
    const worst = [];
    let matched = 0, unmatched = 0;
    for (const o of ours) {
        if (o.regime !== 'L4' && o.regime !== 'L5') continue;
        const a = ast.get(normaliseDesignation(o.des));
        if (!a) { unmatched++; continue; }
        matched++;
        const quality = orbitQuality({ cc: o.condition_code, arc_d: o.data_arc_d }, o.align_method);
        const add = (k, ov, av) => {
            if (ov == null || av == null) return;
            pairs[k].push([ov, av]);
            ((byQuality[quality] ??= {})[k] ??= []).push([ov, av]);
            ((bySpan[`${a.My ?? '?'} Myr`] ??= {})[k] ??= []).push([ov, av]);
        };
        const fBad = !(a.f > F_MIN), DBad = !(a.D > 0), gBad = !(a.g > GT5_LOCK);
        if (fBad) excluded.f_below_1_5_deg_yr++;
        if (DBad) excluded.D_nonpositive++;
        if (gBad) excluded.g_locked_to_g5++;
        if (!fBad && !DBad) {
            add('D', num(o.D_p_deg), a.D); add('da', num(o.da_p_au), a.da); add('f', num(o.f_lib_deg_yr), a.f);
            if (num(o.D_p_deg) != null) worst.push({ des: o.des, name: o.name || null, quality, ours: num(o.D_p_deg), astdys: a.D, diff: num(o.D_p_deg) - a.D, halfrange: num(o.libration_amp_deg), astdys_span_myr: a.My });
        }
        if (!gBad) { add('e', num(o.e_p), a.e); add('g', num(o.g_arcsec_yr), a.g); }
        add('sinI', num(o.sinI_p), a.sinI); add('s', num(o.s_arcsec_yr), a.s);
    }
    // The old statistic on the same objects, for the before/after line.
    const halfrange = ours.filter(o => (o.regime === 'L4' || o.regime === 'L5')).map(o => {
        const a = ast.get(normaliseDesignation(o.des));
        return a && a.D > 0 && a.f > F_MIN && num(o.libration_amp_deg) != null ? [num(o.libration_amp_deg), a.D] : null;
    }).filter(Boolean);
    const result = {
        generated_at: new Date().toISOString(),
        inputs: { analysis: csvFile.split('/').pop(), astdys_source: body.source_url, astdys_header: body.header_line, astdys_rows: body.count },
        matched, unmatched_librators: unmatched, excluded_astdys_rows: excluded,
        agreement: Object.fromEntries(Object.entries(pairs).filter(([, v]) => v.length).map(([k, v]) => [k, stats(v)])),
        agreement_by_quality: Object.fromEntries(Object.entries(byQuality).map(([q, m]) => [q, Object.fromEntries(Object.entries(m).filter(([, v]) => v.length > 2).map(([k, v]) => [k, stats(v)]))])),
        agreement_by_astdys_span: Object.fromEntries(Object.entries(bySpan).map(([q, m]) => [q, Object.fromEntries(Object.entries(m).filter(([, v]) => v.length > 2).map(([k, v]) => [k, stats(v)]))])),
        halfrange_vs_astdys_D: halfrange.length ? stats(halfrange) : null,
        largest_D_disagreements: worst.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff)).slice(0, 25),
    };
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ matched, excluded, agreement: result.agreement, halfrange: result.halfrange_vs_astdys_D }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
