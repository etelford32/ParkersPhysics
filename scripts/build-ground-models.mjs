#!/usr/bin/env node
/**
 * build-ground-models.mjs — bake the 1-D ground-conductivity models into
 * js/earth-interior/ground-models.js (INNER_EARTH_PLAN.md §8 P1).
 *
 *   node scripts/build-ground-models.mjs          write the module
 *   node scripts/build-ground-models.mjs --check  fail if the committed module
 *                                                 or any raw file drifted
 *
 * Source: data/earth-interior/ground-1d/usgs-v1.3/, copied BYTE-FOR-BYTE from
 * greglucas/bezpy @ b7944f9404f3ab59373279f8116cc288e90dc390
 * (bezpy/mt/data_1d/, MIT), and pinned below by sha256. Three provenances
 * live in that directory and each model carries its own:
 *   • USGS ground-conductivity model v1.3 (Fernberg 2012, EPRI 1026430;
 *     Love & Blum, USGS) — the 21 physiographic regions. US government work.
 *   • GSC Open File 8115 (Trichtchenko, Fernberg & Danskin, NRCan) — the
 *     Canadian observatory models. Open Government Licence – Canada (confirm).
 *   • NERC TPL-007 Attachment 1 Table 4 — the Quebec REFERENCE model, the
 *     denominator of every published β.
 *   • BOU — USGS Boulder observatory; its own file says "we are not sure how
 *     it was produced", and the module says so too.
 *
 * TWO TRAPS the parser exists for, both measured on these files:
 *   1. earth_model_BOU.txt DECLARES 11 layers and LISTS 12. bezpy's reader
 *      trusts the count, reads layer 12's σ as the half-space and drops its
 *      thickness; that is harmless only because layer 12's σ equals the
 *      half-space σ. This parser reads every LABELLED layer and then proves
 *      the two readings are the same Earth (a merge of equal-σ neighbours).
 *   2. The `*-slash … !` comment lines carry OLDER thicknesses/resistivities
 *      (v1.2; the README lists the corrections). Data lines win, always.
 *
 * Region NAMES come from a second, independent copy of the same USGS models
 * (butala/pyrsss @ 5b9d347, MIT, tests/fixtures/earth-interior/
 * pyrsss_usgs_conductivity.py), whose layers are cross-checked against
 * bezpy's here — two copies agreeing is the integrity check until the
 * canonical files can be fetched from geomag.usgs.gov.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'data/earth-interior/ground-1d/usgs-v1.3');
const PYRSSS = join(ROOT, 'tests/fixtures/earth-interior/pyrsss_usgs_conductivity.py');
const OUT = join(ROOT, 'js/earth-interior/ground-models.js');
const CHECK = process.argv.includes('--check');

const sha = (b) => createHash('sha256').update(b).digest('hex');

const NRCAN = new Set(['ALE', 'BLC', 'BRD', 'CBB', 'FCC', 'GLN', 'IQA', 'MEA', 'OTT', 'PBQ', 'RES', 'SNK', 'STJ', 'VIC', 'YKC']);
const PROVENANCE = {
    usgs: { source: 'USGS ground-conductivity model v1.3 (Fernberg 2012, EPRI TU 1026430)', license: 'US Government work (public domain)', tier: 'A' },
    nrcan: { source: 'Geological Survey of Canada Open File 8115 (Trichtchenko, Fernberg & Danskin)', license: 'Open Government Licence – Canada (to confirm)', tier: 'B' },
    nerc: { source: 'NERC TPL-007-4 Attachment 1, Table 4 (reference Earth model, Quebec)', license: 'published standard (values)', tier: 'A' },
    bou: { source: 'USGS Boulder observatory profile; its own file: "We are not sure how it was produced."', license: 'US Government work (public domain)', tier: 'A' },
};

/** Parse one file. Returns { declared, layers:[{sigma, thicknessM}], halfspaceSigma }. */
export function parseModel(text, { repairs = null } = {}) {
    const lines = text.split(/\r?\n/).filter((l) => !l.startsWith('*'));
    let declared = null; const layers = []; let half = null; let pending = null;
    for (const l of lines) {
        let tok = l.trim().split(/\s+/)[0];
        // A mantissa+exponent with the 'e' missing ("5.0000+03"). Repaired ONLY
        // when the caller asks (the cross-check copy) and every repair is recorded.
        if (repairs && /^\d+\.\d+\+\d+$/.test(tok)) { repairs.push(tok); tok = tok.replace('+', 'e+'); }
        const num = Number(tok);
        if (!l.trim()) continue;
        if (/Number of layers/i.test(l)) { declared = num; continue; }
        if (/Conductivity in S\/m \(layer/i.test(l)) { pending = num; continue; }
        if (/Layer thickness in m \(layer/i.test(l)) {
            if (pending === null) throw new Error('thickness without conductivity');
            layers.push({ sigma: pending, thicknessM: num }); pending = null; continue;
        }
        if (/Semi-infinite earth conductivity/i.test(l)) { half = num; continue; }
        throw new Error(`unrecognised line: ${l}`);
    }
    if (declared === null || half === null || pending !== null) throw new Error('incomplete model');
    for (const x of [...layers.map((y) => y.sigma), ...layers.map((y) => y.thicknessM), half])
        if (!(x > 0) || !Number.isFinite(x)) throw new Error(`non-positive value ${x}`);
    return { declared, layers, halfspaceSigma: half };
}

/** The Earth bezpy's count-trusting reader would build (trap 1). */
export function parseLikeBezpy(text) {
    const m = parseModel(text);
    const take = m.layers.slice(0, m.declared);
    const half = m.declared < m.layers.length ? m.layers[m.declared].sigma : m.halfspaceSigma;
    return { layers: take, halfspaceSigma: half };
}

/** Merge equal-σ neighbours (incl. into the half-space) — a physically identical Earth. */
export function canonical({ layers, halfspaceSigma }) {
    const out = [];
    for (const l of layers) {
        if (out.length && out[out.length - 1].sigma === l.sigma) out[out.length - 1].thicknessM += l.thicknessM;
        else out.push({ ...l });
    }
    while (out.length && out[out.length - 1].sigma === halfspaceSigma) out.pop();
    return { layers: out, halfspaceSigma };
}

function pyrsssModels(repairLog) {
    const src = readFileSync(PYRSSS, 'utf8');
    const out = {};
    for (const m of src.matchAll(/"""\n([^"]*?)\n"""\n([A-Z0-9_]+) = """\\?\n([\s\S]*?)"""/g)) {
        const id = m[2].replace('_', '');
        const repairs = [];
        out[id] = { name: m[1].replace(/\s+/g, ' ').trim(), model: parseModel(m[3], { repairs }) };
        if (repairs.length) repairLog.push(`pyrsss ${id}: repaired ${repairs.join(', ')} (missing 'e')`);
    }
    return out;
}

function build() {
    const files = readdirSync(RAW).filter((f) => /^earth_model_.*\.txt$/.test(f)).sort();
    const pins = {}; const models = []; const notes = [];
    const repairLog = [];
    const py = pyrsssModels(repairLog);
    for (const f of files) {
        const id = f.replace(/^earth_model_|\.txt$/g, '');
        const text = readFileSync(join(RAW, f), 'utf8');
        pins[f] = sha(Buffer.from(text, 'utf8'));
        const m = parseModel(text);
        if (m.declared !== m.layers.length) {
            const a = canonical(m), b = canonical(parseLikeBezpy(text));
            if (JSON.stringify(a) !== JSON.stringify(b))
                throw new Error(`${id}: declared ${m.declared} ≠ listed ${m.layers.length} AND the two readings differ`);
            notes.push(`${id}: declares ${m.declared} layers, lists ${m.layers.length}; both readings are the same Earth`);
        }
        const kind = id === 'QUE' ? 'nerc' : id === 'BOU' ? 'bou' : NRCAN.has(id) ? 'nrcan' : 'usgs';
        let name = py[id]?.name ?? null;
        if (kind === 'usgs') {
            if (!py[id]) throw new Error(`${id}: no pyrsss cross-copy`);
            if (JSON.stringify(canonical(py[id].model)) !== JSON.stringify(canonical(m)))
                throw new Error(`${id}: bezpy and pyrsss copies DISAGREE`);
        }
        if (kind === 'nerc') name = 'NERC TPL-007 reference Earth (Quebec)';
        if (kind === 'bou') name = 'Boulder observatory (BOU)';
        if (kind === 'nrcan') name = `NRCan observatory model (${id})`;
        models.push({ id, kind, name, ...PROVENANCE[kind], layers: m.layers, halfspaceSigma: m.halfspaceSigma });
    }
    const readme = readFileSync(join(RAW, '00README.txt'));
    pins['00README.txt'] = sha(readme);
    const usgsCount = models.filter((x) => x.kind === 'usgs').length;
    if (usgsCount !== Object.keys(py).length) throw new Error(`USGS regions ${usgsCount} vs pyrsss ${Object.keys(py).length}`);
    // The cross-copy defects we accept, exactly. Anything new must be looked at.
    const EXPECTED_REPAIRS = ["pyrsss FL1: repaired 5.0000+03 (missing 'e')"];
    if (JSON.stringify(repairLog) !== JSON.stringify(EXPECTED_REPAIRS)) throw new Error(`unexpected cross-copy repairs: ${repairLog.join('; ')}`);
    notes.push(...repairLog.map((r) => `${r} — after it the two copies agree`));

    const body = `/**
 * ground-models.js — GENERATED by scripts/build-ground-models.mjs. Do not edit;
 * edit the raw files' pins in the builder and re-run it (\`--check\` in CI).
 *
 * 1-D layer-cake ground-conductivity models: σ (S/m) and thickness (m) per
 * layer from the surface down, then a half-space. They are REGIONAL
 * LITERATURE SYNTHESES (the USGS README: "NOT on any single field study … should
 * not be considered definitive, or even self-consistent"), not measurements at
 * a site. Real ground is 3-D; a 1-D column is the TPL-007 planning method and
 * every consumer must say which column it used.
 *
 * Region boundaries (which model applies WHERE) are USGS's KMZ at
 * geomag.usgs.gov/conductivity/, egress-blocked at build time and NOT baked —
 * so nothing here maps a location to a model. A model is chosen by id.
 *
 * Parser notes: ${notes.join('; ') || 'none'}.
 */

export const GROUND_MODEL_SOURCE = Object.freeze({
    copiedFrom: 'greglucas/bezpy @ b7944f9404f3ab59373279f8116cc288e90dc390 (bezpy/mt/data_1d, MIT)',
    crossChecked: 'butala/pyrsss @ 5b9d347de404d9f5739fabb7d356fdb3ff7e6b65 (USGS regions, MIT)',
    canonical: 'https://geomag.usgs.gov/conductivity/ (UNVERIFIED against the canonical files)',
});

export const GROUND_MODELS = Object.freeze(${JSON.stringify(models, null, 1)
        .replace(/\n\s*/g, ' ')
        .replace(/\{ "id"/g, '\n    { "id"')}.map((m) => Object.freeze({ ...m, layers: Object.freeze(m.layers.map((l) => Object.freeze(l))) })));

export const GROUND_MODEL_PINS = Object.freeze(${JSON.stringify(pins, null, 4)});
`;
    return body;
}

const out = build();
if (CHECK) {
    const cur = readFileSync(OUT, 'utf8');
    if (cur !== out) { console.error('ground-models.js is stale — run node scripts/build-ground-models.mjs'); process.exit(1); }
    console.log('ground-models.js up to date');
} else {
    writeFileSync(OUT, out);
    console.log(`wrote ${OUT}`);
}
