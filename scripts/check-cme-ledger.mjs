#!/usr/bin/env node
// scripts/check-cme-ledger.mjs — is the CME forecast ledger being updated?
//
// Fetches /api/cme/skill from a deployment and applies checkLedgerPayload
// (js/cme-ledger-status.js, node-gated by tests/cme-ledger-status.mjs): the
// daily cron must have run within 26 h, must not be failing, and today's
// eruption outlook must be on the calendar. A QUIET SUN PASSES — zero events
// and zero locks are a healthy answer; a pipeline that did not run is not.
//
//   node scripts/check-cme-ledger.mjs [--base https://www.parkersphysics.com]
//
// Run daily by .github/workflows/cme-ledger-daily.yml, 07:40 UT (the cron
// fires 06:30 UT). Exit 1 on any problem, 2 when the route is unreachable.

import { checkLedgerPayload } from '../js/cme-ledger-status.js';

const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const base = arg('--base', process.env.CME_LEDGER_BASE || 'https://www.parkersphysics.com').replace(/\/$/, '');
// Cache-buster: the route is CDN-cached 10 min and a probe must not read an
// answer older than the run it is checking for.
const url = `${base}/api/cme/skill?events=60&probe=${Date.now()}`;

let payload;
try {
    const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'parkersphysics-ledger-probe' },
        signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = await res.json();
} catch (e) {
    console.error(`cme-ledger probe: ${url} unreachable — ${e?.message ?? e}`);
    process.exit(2);
}

const ledger = payload?.data?.ledger ?? {};
const outlook = payload?.data?.outlook ?? {};
console.log(`last run   ${ledger.last_run ?? '—'}  (${ledger.age_h ?? '?'} h ago, ${ledger.basis ?? 'no basis'})`);
console.log(`run said   ${ledger.summary ?? ledger.last_failure_reason ?? '—'}`);
console.log(`freshness  ${payload?.freshness ?? '—'}`);
console.log(`events     ${payload?.data?.events?.length ?? '—'}   outlook days ${outlook.days?.length ?? '—'}   newest issue ${outlook.run_days?.at?.(-1) ?? '—'}`);

const problems = checkLedgerPayload(payload, Date.now());
if (problems.length) {
    for (const p of problems) console.error(`::error title=CME ledger not updated::${p}`);
    process.exit(1);
}
console.log('cme-ledger probe: ledger is current');
