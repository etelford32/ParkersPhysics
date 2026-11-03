#!/usr/bin/env node
/**
 * scripts/merge-long-proper.mjs — fill the dynamics artifact's SECULAR proper
 * elements (e_p, g, sin I_p, s) from the long run.
 *
 *   node scripts/merge-long-proper.mjs data/trojans/trojans-dynamics.json <long trojans-analysis.csv> [--years N]
 *
 * The committed artifact comes from the 600-yr run, which resolves the
 * libration (D_p, f) but NOT the secular lines: e_p / g need ≳ 18 kyr and
 * sin I_p / s ≳ 250 kyr (js/trojan-dynamics.js PROPER.secularMinSpanYears).
 * The weekly 20-kyr run resolves e_p / g; this copies them in BY DESIGNATION
 * (never by row order) and records where they came from. A value the long run
 * withheld stays null. The 600-yr D_p / f are left as they are.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { decodeDynamics, DYNAMICS_FORMAT } from '../js/trojan-dynamics.js';

const [artifactFile, longCsv] = process.argv.slice(2);
if (!artifactFile || !longCsv) { console.error('usage: merge-long-proper.mjs <trojans-dynamics.json> <long analysis.csv> [--years N]'); process.exit(2); }
const k = process.argv.indexOf('--years');
const years = k > 0 ? Number(process.argv[k + 1]) : null;

const doc = JSON.parse(readFileSync(artifactFile, 'utf8'));
if (doc.format !== DYNAMICS_FORMAT) throw new Error(`not a ${DYNAMICS_FORMAT} artifact`);
decodeDynamics(doc);   // validates the shape before anything is written

const lines = readFileSync(longCsv, 'utf8').trim().split('\n');
const head = lines[0].split(',');
const at = (name) => head.indexOf(name);
const iDes = at('des'), iE = at('e_p'), iG = at('g_arcsec_yr'), iI = at('sinI_p'), iS = at('s_arcsec_yr');
if ([iDes, iE, iG, iI, iS].some(i => i < 0)) throw new Error('long-run CSV lacks the proper-element columns');
// Designations never contain commas, and these numeric columns are unquoted.
const byDes = new Map();
for (const l of lines.slice(1)) {
    const c = l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map(x => x.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"'));
    byDes.set(c[iDes], c);
}
const num = (v) => (v === '' || v == null ? null : Number(v));
const cols = { e_p: [iE, 4], g: [iG, 2], sinI_p: [iI, 4], s: [iS, 2] };
let filled = 0;
const n = doc.count;
for (const [col, [idx, dp]] of Object.entries(cols)) {
    const arr = doc.data[col] ?? (doc.data[col] = new Array(n).fill(null));
    for (let r = 0; r < n; r++) {
        const row = byDes.get(doc.data.des[r]);
        const v = row ? num(row[idx]) : null;
        if (v != null) { arr[r] = Number(v.toFixed(dp)); if (col === 'e_p') filled++; }
    }
}
doc.proper_secular_from = { run_years: years, merged_at: new Date().toISOString(), e_p_filled: filled,
    note: 'e_p/g/sin I_p/s from the long run (withheld where it could not resolve them); D_p/f from the 600-yr run' };
writeFileSync(artifactFile, JSON.stringify(doc) + '\n');
console.log(`merged secular proper elements for ${filled} of ${n} objects from ${longCsv.split('/').pop()}`);
