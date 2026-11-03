#!/usr/bin/env node
/**
 * scripts/analyze-trojans.mjs — run js/trojan-dynamics.js over the WHOLE
 * Jupiter Trojan catalogue and write the population tables.
 *
 *   node scripts/analyze-trojans.mjs <catalog.json> [--years 600] [--dt 20] [--out data/trojans] [--require-live]
 *
 * --require-live refuses (exit 3) a catalogue that is not `freshness: 'live'`
 * with Jupiter from Horizons, or that is implausibly small — the scheduled
 * refresh must never commit tables computed from a degraded body.
 *
 * <catalog.json> is a saved /api/trojans/catalog body (the sandbox cannot
 * reach JPL; fetch it from a deployment: `curl https://<host>/api/trojans/catalog > cat.json`).
 *
 * Writes:
 *   <out>/trojans-dynamics.json  the COMPACT per-object artifact pages load
 *                                (js/trojan-dynamics.js DYNAMICS_FORMAT) — committed
 *   <out>/trojans-summary.json   population statistics + provenance — committed
 *   <out>/trojans-analysis.csv   the FULL per-object table (instant φ, analytic and
 *                                integrated libration, orbit quality …) — NOT
 *                                committed (~3 MB per refresh); the refresh
 *                                workflow uploads it as a build artifact
 *
 * The integration is split across worker threads (each rebuilds the same
 * deterministic planet track — the planets are integrated identically in
 * every worker, so results do not depend on the split).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';
import * as T from '../js/trojan-dynamics.js';

if (!isMainThread) {
    const { particles, perturbers, opts } = workerData;
    const run = T.integrateSwarm(particles, perturbers, {
        ...opts, onProgress: (d, n) => parentPort.postMessage({ progress: d, total: n }),
    });
    parentPort.postMessage({ done: run.results });
} else {
    await main();
}

function arg(name, def) {
    const k = process.argv.indexOf(`--${name}`);
    return k > 0 ? process.argv[k + 1] : def;
}

async function main() {
    const file = process.argv[2];
    if (!file) { console.error('usage: analyze-trojans.mjs <catalog.json> [--years N] [--dt D] [--out dir]'); process.exit(2); }
    const years = Number(arg('years', T.SWARM_RUN.years));
    const dtDays = Number(arg('dt', T.SWARM_RUN.dtDays));
    const out = arg('out', 'data/trojans');
    const limit = Number(arg('limit', Infinity));
    const body = JSON.parse(readFileSync(file, 'utf8'));
    const epoch = body.epoch?.epoch;
    if (!Number.isFinite(epoch)) throw new Error('catalogue has no epoch');
    const pert = T.perturberStates(body.perturbers, epoch);
    if (process.argv.includes('--require-live')) {
        const problems = [];
        if (body.freshness !== 'live') problems.push(`freshness ${body.freshness} (${body.degraded_reason ?? 'no reason'})`);
        if (pert.jupiter.source !== 'horizons') problems.push(`Jupiter from ${pert.jupiter.source}, not Horizons`);
        if (!(body.rows?.length >= 10_000)) problems.push(`only ${body.rows?.length ?? 0} rows (TJN held 16 445 on 2026-11-03)`);
        if (problems.length) { console.error(`refusing to analyse a degraded catalogue: ${problems.join('; ')}`); process.exit(3); }
    }
    // One decoder for every catalogue shape (lean 'trojan-v2' and the original rows).
    const recs = T.recordsFromCatalog(body).slice(0, limit);

    const ta = Date.now();
    const aligned = T.alignToEpoch(recs, pert, epoch);   // its own finer step (ALIGN_DT_DAYS)
    process.stderr.write(`  aligned ${recs.length} rows to JD ${epoch} in ${((Date.now() - ta) / 1000).toFixed(1)} s\n`);
    const analysed = [];
    const skipped = [];
    recs.forEach((r, k) => {
        const a = T.analyseRecord(r, pert.jupiter, epoch, aligned[k]);
        if (a) { a._k = k; a.rec = r; analysed.push(a); } else skipped.push(r.des);
    });
    const particles = analysed.map(a => a.state ?? T.stateFromElements(a.el));
    const plain = (p) => ({ r: p.r, v: p.v, m: p.m, gm: p.gm, source: p.source });
    const perturbers = { jupiter: plain(pert.jupiter), saturn: plain(pert.saturn) };

    const nW = Math.min(availableParallelism(), 8);
    const chunk = Math.ceil(particles.length / nW);
    const t0 = Date.now();
    const done = new Array(nW).fill(0);
    const parts = await Promise.all(Array.from({ length: nW }, (_, w) => new Promise((resolve, reject) => {
        const slice = particles.slice(w * chunk, (w + 1) * chunk);
        if (!slice.length) return resolve([]);
        const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { particles: slice, perturbers, opts: { years, dtDays } } });
        worker.on('message', (m) => {
            if (m.progress) {
                done[w] = m.progress;
                const total = done.reduce((s, x) => s + x, 0);
                process.stderr.write(`\r  integrated ${total}/${particles.length}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
            }
            if (m.done) resolve(m.done);
        });
        worker.on('error', reject);
    })));
    process.stderr.write('\n');
    const results = parts.flat();

    // ── Table ──────────────────────────────────────────────────────────────
    mkdirSync(out, { recursive: true });
    const f = (v, d) => (v == null || !Number.isFinite(v) ? '' : v.toFixed(d));
    const q = (s) => (s == null ? '' : /[",]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s);
    const header = 'des,name,H,diameter_km,size_basis,albedo,spec,a_au,e,i_deg,phi_deg,camp_at_epoch,analytic_regime,analytic_amp_deg,regime,phi_min_deg,phi_max_deg,phi_mean_deg,libration_amp_deg,libration_period_yr,a_mean_au,e_mean,i_mean_deg,e_max,epoch_offset_d,align_method,condition_code,data_arc_d,n_obs';
    const lines = [header];
    analysed.forEach((a, k) => {
        const r = results[k];
        lines.push([
            q(a.des), q(a.name), f(a.H, 2), f(a.diameterKm, 1), a.sizeBasis, f(a.albedo, 3), q(a.spec),
            f(a.a, 5), f(a.e, 4), f(a.i, 3), f(a.phi, 2), a.camp,
            a.analytic.regime, f(a.analytic.amplitude, 2),
            r.regime, f(r.phiMin, 2), f(r.phiMax, 2), f(r.phiMean, 2), f(r.amplitude, 2), f(r.periodYears, 1),
            f(r.aMean, 5), f(r.eMean, 4), f(r.iMean, 3), f(r.eMax, 4), f(a.epochOffsetDays, 0), a.alignMethod, q(recs[a._k]?.cc), recs[a._k]?.arc_d ?? '', recs[a._k]?.n_obs ?? '',
        ].join(','));
    });
    writeFileSync(`${out}/trojans-analysis.csv`, lines.join('\n') + '\n');

    // ── Summary ────────────────────────────────────────────────────────────
    const count = (pred) => results.reduce((n, r, k) => n + (pred(r, analysed[k]) ? 1 : 0), 0);
    const regimes = {};
    for (const r of results) regimes[r.regime] = (regimes[r.regime] || 0) + 1;
    const lib = results.map((r, k) => ({ r, a: analysed[k] })).filter(x => x.r.regime === 'L4' || x.r.regime === 'L5');
    const median = (xs) => { const s = xs.filter(Number.isFinite).sort((p, q2) => p - q2); return s.length ? s[Math.floor(s.length / 2)] : null; };
    const agree = lib.filter(x => x.a.analytic.regime === 'tadpole');
    const dAmp = agree.map(x => x.r.amplitude - x.a.analytic.amplitude);
    const summary = {
        generated_at: new Date().toISOString(),
        source: { file: basename(file), catalogue_generated_at: body.generated_at, freshness: body.freshness, precision: body.precision,
            epoch_jd: epoch, rows: body.rows.length, jupiter: pert.jupiter.source, saturn: pert.saturn.source },
        run: { years, dtDays, workers: nW, seconds: Math.round((Date.now() - t0) / 1000), skipped: skipped.length },
        regimes,
        alignment: analysed.reduce((m, a) => { m[a.alignMethod] = (m[a.alignMethod] || 0) + 1; return m; }, {}),
        // Orbit quality: JPL condition code U (0 best … 9 worst). 'short-arc'
        // = U ≥ 6 OR data arc < 1 yr — orbits whose a is too uncertain for a
        // libration verdict to mean much.
        regimes_by_quality: analysed.reduce((m, a, k) => {
            const key = `${T.orbitQuality(recs[a._k], a.alignMethod)}:${results[k].regime}`; m[key] = (m[key] || 0) + 1; return m;
        }, {}),
        regimes_by_alignment: analysed.reduce((m, a, k) => { const key = `${a.alignMethod}:${results[k].regime}`; m[key] = (m[key] || 0) + 1; return m; }, {}),
        camps_at_epoch: T.campRatio(count((_, a) => a.camp === 'L4'), count((_, a) => a.camp === 'L5')),
        camps_librating: T.campRatio(regimes.L4 || 0, regimes.L5 || 0),
        // The asymmetry split by orbit quality: if the two buckets disagree,
        // part of the catalogue's L4 excess is HOW the swarms were discovered.
        camps_librating_by_quality: Object.fromEntries(['well-determined', 'short-arc'].map(b => [b, T.campRatio(
            analysed.filter((a, k) => T.orbitQuality(recs[a._k], a.alignMethod) === b && results[k].regime === 'L4').length,
            analysed.filter((a, k) => T.orbitQuality(recs[a._k], a.alignMethod) === b && results[k].regime === 'L5').length)])),
        librating: {
            median_amplitude_deg: median(lib.map(x => x.r.amplitude)),
            median_period_yr: median(lib.map(x => x.r.periodYears)),
            median_i_mean_deg: median(lib.map(x => x.r.iMean)),
            median_e_mean: median(lib.map(x => x.r.eMean)),
            analytic_vs_integrated_amp: { n: dAmp.length, median_diff_deg: median(dAmp), median_abs_diff_deg: median(dAmp.map(Math.abs)) },
        },
        sizes: { measured: count((_, a) => a.sizeBasis === 'measured'), from_measured_albedo: count((_, a) => a.sizeBasis === 'H+measured-albedo'),
            from_population_albedo: count((_, a) => a.sizeBasis === 'H+population-albedo'), population_albedo: T.TROJAN_MEAN_ALBEDO },
    };
    writeFileSync(`${out}/trojans-summary.json`, JSON.stringify(summary, null, 2) + '\n');
    // The compact artifact pages load (one row per object, codes expanded by
    // T.decodeDynamics). Provenance + the summary ride along so a page can
    // print WHEN and FROM WHAT without a second request.
    const artifact = T.encodeDynamics(analysed, results, {
        generated_at: summary.generated_at, source: summary.source, run: summary.run,
        summary: { regimes: summary.regimes, camps_librating: summary.camps_librating,
            camps_librating_by_quality: summary.camps_librating_by_quality, librating: summary.librating },
    });
    writeFileSync(`${out}/trojans-dynamics.json`, JSON.stringify(artifact) + '\n');
    console.log(JSON.stringify(summary, null, 2));
}
