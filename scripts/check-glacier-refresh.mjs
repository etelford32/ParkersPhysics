#!/usr/bin/env node
/**
 * scripts/check-glacier-refresh.mjs — refuse to publish a DEGRADED Glacier Watch refresh.
 *
 * The weekly job (.github/workflows/glacier-refresh.yml) re-bakes every glacier with
 * `--keep-going`, so an upstream hiccup (an S3 listing that times out, a composite that
 * 404s for an hour) does not cost the whole run: that glacier keeps its previous entry and
 * is LISTED in the run report. This check decides whether what came out is fit to open a PR
 * with, comparing the committed index (git HEAD) with the fresh one. It never fixes
 * anything — a refused refresh simply opens no PR and the run goes red.
 *
 * REFUSED (each is something that looked like a successful bake and was not):
 *   • a glacier disappeared from the index;
 *   • nothing was refreshed at all (every bake failed — e.g. S3 unreachable);
 *   • too many failures: more than max(2, 20 %) of the glaciers kept a stale entry;
 *   • a refreshed glacier's kept pairs COLLAPSED (≥ 20 before, < half now) — the listing or
 *     the sampler broke, the satellites did not stop flying;
 *   • a refreshed glacier's flowline length moved by > 25 % — the line is re-traced each bake
 *     from the composite + DEM, so a jump means a new composite release or a changed seed rule
 *     and must be looked at by a human (every stored sample was re-read at new points).
 * Listed but allowed: individual failures under the cap (with the date their entry is from).
 *
 * Usage: node scripts/check-glacier-refresh.mjs <prev glaciers.json> <next glaciers.json> [run.json] [--md out.md]
 */
import { readFileSync, writeFileSync } from 'node:fs';

export const RULES = Object.freeze({ maxFailFrac: 0.2, maxFailMin: 2, pairsFloor: 20, pairsKeep: 0.5, flowlineJump: 0.25 });

/** PURE. prev/next: parsed glaciers.json; report: the baker's --report JSON (or null). */
export function compareArchives(prev, next, report = null, rules = RULES) {
    const P = new Map((prev?.glaciers || []).map(g => [g.id, g]));
    const N = new Map((next?.glaciers || []).map(g => [g.id, g]));
    const problems = [], warnings = [], rows = [];
    for (const id of P.keys()) if (!N.has(id)) problems.push(`${id}: missing from the refreshed index`);
    const failed = new Set(report?.failed || []);
    let refreshed = 0;
    for (const [id, g] of N) {
        const p = P.get(id);
        // the run report is the authority on what was re-baked (a same-day re-run keeps the date);
        // without one, a moved bake date is the evidence
        const fresh = !failed.has(id) && (report ? !!report.glaciers?.[id]?.ok : (!p || g.baked !== p.baked));
        if (fresh) refreshed++;
        const row = { id, baked: g.baked, pairs: g.pairs_count, prevPairs: p?.pairs_count ?? null,
                      km: g.flowline.length_m / 1000, prevKm: p ? p.flowline.length_m / 1000 : null,
                      reused: g.pairs_reused ?? null, status: failed.has(id) ? 'failed' : fresh ? (p ? 'refreshed' : 'new') : 'unchanged' };
        rows.push(row);
        if (failed.has(id)) {
            const why = report?.glaciers?.[id]?.error || 'unknown error';
            warnings.push(`${id}: bake failed (${why}) — kept the entry from ${g.baked}`);
            continue;
        }
        if (!fresh || !p) continue;
        if (p.pairs_count >= rules.pairsFloor && g.pairs_count < rules.pairsKeep * p.pairs_count)
            problems.push(`${id}: kept pairs collapsed ${p.pairs_count} → ${g.pairs_count}`);
        const d = Math.abs(row.km - row.prevKm) / Math.max(1e-9, row.prevKm);
        if (d > rules.flowlineJump)
            problems.push(`${id}: flowline length moved ${row.prevKm.toFixed(1)} → ${row.km.toFixed(1)} km (${(100 * d).toFixed(0)} %) — re-traced on new inputs; review before publishing`);
    }
    if (N.size && refreshed === 0) problems.push('nothing was refreshed — every bake failed or was skipped');
    const cap = Math.max(rules.maxFailMin, Math.floor(rules.maxFailFrac * N.size));
    if (failed.size > cap) problems.push(`${failed.size} glaciers failed (cap ${cap}) — upstream looks degraded`);
    const dates = rows.filter(r => r.baked).map(r => r.baked).sort();
    return { ok: problems.length === 0, problems, warnings, rows, refreshed, failed: [...failed],
             asOf: dates.at(-1) ?? null, asOfOldest: dates[0] ?? null };
}

/** The PR body's table. */
export function markdown(res) {
    const f = (v, d = 0) => (v == null ? '—' : Number(v).toFixed(d));
    const lines = [
        `**${res.refreshed} refreshed**, ${res.failed.length} failed · archive as of **${res.asOf}**` +
            (res.asOfOldest && res.asOfOldest !== res.asOf ? ` (oldest entry ${res.asOfOldest})` : ''),
        '',
    ];
    if (res.problems.length) lines.push('**Refused:**', ...res.problems.map(p => `- ${p}`), '');
    if (res.warnings.length) lines.push('**Warnings:**', ...res.warnings.map(p => `- ${p}`), '');
    lines.push('| glacier | status | pairs (was) | reused | flowline km (was) |', '|---|---|---|---|---|');
    for (const r of res.rows) lines.push(`| ${r.id} | ${r.status} | ${f(r.pairs)} (${f(r.prevPairs)}) | ${f(r.reused)} | ${f(r.km, 1)} (${f(r.prevKm, 1)}) |`);
    return lines.join('\n') + '\n';
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const args = process.argv.slice(2);
    const mdAt = args.indexOf('--md');
    const md = mdAt >= 0 ? args.splice(mdAt, 2)[1] : null;
    const [a, b, r] = args;
    if (!a || !b) { console.error('usage: check-glacier-refresh.mjs <prev> <next> [run.json] [--md out.md]'); process.exit(2); }
    const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
    const res = compareArchives(read(a), read(b), r ? read(r) : null);
    const text = markdown(res);
    if (md) writeFileSync(md, text);
    console.log(text);
    if (!res.ok) { console.error('REFUSED: ' + res.problems.join('; ')); process.exit(1); }
}
