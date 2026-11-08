#!/usr/bin/env node
/**
 * dev-log-draft.mjs — which merged PRs are not in the build log yet?
 * ═══════════════════════════════════════════════════════════════════════════
 * Reads `git log --first-parent` for squash-merge subjects ending "(#NNNN)",
 * subtracts every PR already in js/dev-log.js DEV_LOG and UNLOGGED_PRS, and
 * prints a stub entry for each one that is left — date, PR, the root pages it
 * touched, and a section guessed from the simulations catalogue. The stubs
 * are a STARTING POINT: rewrite the title and summary for a visitor before
 * pasting (see the ADDING AN ENTRY notes in js/dev-log.js).
 *
 * It only looks at PRs merged ON OR AFTER the oldest logged entry, so the log
 * does not have to reach back to the beginning of the repo.
 *
 * Usage:
 *   node scripts/dev-log-draft.mjs              # print stubs (exit 0)
 *   node scripts/dev-log-draft.mjs --check      # exit 1 if anything is unlogged
 *   node scripts/dev-log-draft.mjs --since 2026-10-01
 *
 * Needs full history on the current branch: a shallow clone (`git clone
 * --depth 1`, the default in many CI checkouts) sees one commit and reports
 * nothing, which is why this is a local tool and not a CI gate.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DEV_LOG, UNLOGGED_PRS, sprintFor, latest } from '../js/dev-log.js';
import { SIMULATIONS } from '../js/simulations-catalog.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const check = args.includes('--check');
const sinceArg = args.includes('--since') ? args[args.indexOf('--since') + 1] : null;
const oldest = [...DEV_LOG].sort((a, b) => a.date.localeCompare(b.date))[0];
const since = sinceArg || (oldest ? oldest.date : '2026-01-01');

function git(...a) {
    return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
}

const logged = new Set(DEV_LOG.map(e => e.pr).filter(Boolean));
const skipped = new Set(Object.keys(UNLOGGED_PRS).map(Number));

const rows = git('log', '--first-parent', `--since=${since}T00:00:00`, '--format=%H%x09%ad%x09%s', '--date=short')
    .split('\n').filter(Boolean)
    .map(line => {
        const [hash, date, subject] = line.split('\t');
        const m = subject.match(/\(#(\d+)\)\s*$/);
        return m ? { hash, date, subject: subject.replace(/\s*\(#\d+\)\s*$/, ''), pr: Number(m[1]) } : null;
    })
    .filter(Boolean)
    .filter(r => !logged.has(r.pr) && !skipped.has(r.pr));

if (rows.length === 0) {
    const newest = latest(1)[0];
    console.log(`✅ build log is up to date (${DEV_LOG.length} entries, newest ${newest ? newest.date : '—'}; `
        + `looked at PRs merged since ${since}).`);
    process.exit(0);
}

const HUB_PAGES = new Set(['space-weather-hub.html', 'earth-orbit.html', 'local-space.html',
    'deep-space.html', 'research.html', 'simulations.html']);

console.log(`⚠  ${rows.length} merged PR(s) since ${since} are not in js/dev-log.js.\n`
    + `   Rewrite each stub for a visitor, paste at the top of DEV_LOG (newest first),\n`
    + `   or add the PR to UNLOGGED_PRS with a reason. Then: node tests/dev-log.mjs\n`);

for (const r of rows) {
    const pages = git('show', '--name-only', '--format=', r.hash).split('\n')
        .filter(f => /^[a-z0-9-]+\.html$/.test(f) && !HUB_PAGES.has(f));
    const sims = pages.map(p => SIMULATIONS.find(s => s.href === p)).filter(Boolean);
    const section = sims[0] ? sims[0].category : 'platform';
    const icon = sims[0] ? sims[0].icon : 'engine';
    const id = r.subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '');
    const links = pages.slice(0, 3).map(p => `{ href: '${p}' }`).join(', ');
    const sprint = sprintFor(r.date);
    console.log(`    // PR #${r.pr} — ${r.subject}${sprint ? '' : '   ⚠ no sprint covers this date — extend SPRINTS'}
    { id: '${id}', date: '${r.date}', pr: ${r.pr},
      title: ${JSON.stringify(r.subject)}, kind: 'improvement', section: '${section}', icon: '${icon}',
      summary: 'TODO: what can a visitor now open, see, or trust? One or two sentences, ending with a period.',
      links: [${links}] },
`);
}

process.exit(check ? 1 : 0);
