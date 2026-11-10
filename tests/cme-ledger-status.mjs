// tests/cme-ledger-status.mjs — the daily-run record behind the CME forecast
// calendar (js/cme-ledger-status.js), the /api/cme/skill route that serves
// it, and the check the daily production probe fails on.
//
// The route runs for real against a fake PostgREST. The 2026-11-09 scenario
// is REAL production state: 53 events, last flux-rope lock 2026-10-14, three
// glancing CMEs with baseline rows only, the cron healthy and running daily.
//
//   node tests/cme-ledger-status.mjs

import { readFileSync } from 'node:fs';

let failures = 0;
function check(label, ok, detail = '') {
    if (ok) console.log(`  ok  ${label}${detail ? ` — ${detail}` : ''}`);
    else { failures++; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

const {
    LEDGER_PIPELINE, LEDGER_FRESH_H, LEDGER_EXPIRED_H, ledgerFreshness, ledgerRunLine,
    outlookByDay, dayRunState, checkLedgerPayload, screenedEvent,
} = await import('../js/cme-ledger-status.js');

const H = 3600e3, DAY = 86400e3;
const NOW = Date.parse('2026-11-09T21:40:00Z');
const RUN = Date.parse('2026-11-09T06:30:33Z');

// ── 1. Freshness ─────────────────────────────────────────────────────────────
check('a run 15 h ago is fresh', ledgerFreshness(RUN, NOW).state === 'fresh');
check('one missed run (30 h) is stale', ledgerFreshness(NOW - 30 * H, NOW).state === 'stale');
check('two missed runs (51 h) is expired', ledgerFreshness(NOW - 51 * H, NOW).state === 'expired');
check('no run time is unknown, never fresh', ledgerFreshness(NaN, NOW).state === 'unknown');
{
    const { HEARTBEAT_PIPELINES, PIPELINES } = await import('../js/pipeline-registry.js');
    const hb = HEARTBEAT_PIPELINES.find((p) => p.key === LEDGER_PIPELINE);
    check('heartbeat thresholds are the module\'s (26 h / 50 h)',
        hb?.warnMin === LEDGER_FRESH_H * 60 && hb?.critMin === LEDGER_EXPIRED_H * 60);
    const route = PIPELINES.find((p) => p.endpoint === '/api/cme/skill');
    check('/api/cme/skill is no longer freshnessExempt (its age is now real)',
        route && route.freshnessExempt !== true && route.warnAgeS === LEDGER_FRESH_H * 3600);
}

// ── 2. The run line (production's 2026-11-09 summary, verbatim shape) ────────
{
    const quiet = ledgerRunLine({
        catalog: 44,
        cmeProgram: { events: 2, locked: 0, resolved: 0, falseAlarms: 0, pending: 0 },
        fluxRope: { locked: 0, scored: 0, bzResolved: 0, idle: 'no-earth-directed-cme' },
        outlook: { issued: { regions: 7, p: [0, 0, 0, 0, 0, 0, 0] }, resolved: 7, pending: 7 },
    });
    check('a quiet run is a SUCCESS and says what it screened', !quiet.failed
        && quiet.text === '44 CMEs screened · 2 Earth-relevant · 0 new locks · flux-rope idle (no Earth-directed CME) · outlook issued',
        quiet.text);
    const broken = ledgerRunLine({ catalog: 0,
        cmeProgram: { reason: 'lock_resolve_failed: DONKI CMEAnalysis: non-JSON (text/html)' },
        fluxRope: { reason: 'no_catalog' }, outlook: {} });
    check('a failed lock is a FAILURE carrying the reason', broken.failed && /non-JSON/.test(broken.text));
    const noOutlook = ledgerRunLine({ catalog: 3, cmeProgram: { events: 0, locked: 0 },
        fluxRope: { locked: 0, idle: 'cme-train-passed' }, outlook: { issued: { reason: 'regions_failed: HTTP 503' } } });
    check('a dead regions feed is disclosed, not a failed ledger', !noOutlook.failed
        && /outlook not issued \(regions_failed/.test(noOutlook.text), noOutlook.text);
}

// ── 3. Per-day outlook + run evidence ────────────────────────────────────────
const issue = (issue_day, valid_day, lead_days, p, extra = {}) => ({
    issue_day, valid_day, lead_days, p_arrival: p, p_geo: p / 2, lower_bound: lead_days >= 3,
    obs_arrival: null, obs_geo: null, resolved_at: null, issued_at: `${issue_day}T06:30:32Z`, ...extra,
});
const OUTLOOK_ROWS = [];
for (const d of ['2026-11-06', '2026-11-07', '2026-11-09']) {         // 11-08: NO RUN
    for (let lead = 0; lead < 7; lead++) {
        const valid = new Date(Date.parse(`${d}T00:00:00Z`) + lead * DAY).toISOString().slice(0, 10);
        OUTLOOK_ROWS.push(issue(d, valid, lead, 0.01 * (lead + 1) + (d === '2026-11-09' ? 0.1 : 0),
            d === '2026-11-06' && lead === 0 ? { resolved_at: '2026-11-09T06:30:00Z', obs_arrival: false } : {}));
    }
}
OUTLOOK_ROWS.sort((a, b) => (a.issued_at < b.issued_at ? 1 : -1));
{
    const o = outlookByDay(OUTLOOK_ROWS);
    check('run days are the issue days', o.run_days.join() === '2026-11-06,2026-11-07,2026-11-09');
    const d10 = o.days.find((d) => d.day === '2026-11-10');
    check('a valid day shows its LATEST issue (shortest lead)', d10.issue_day === '2026-11-09' && d10.lead_days === 1
        && Math.abs(d10.p_arrival - 0.12) < 1e-9);
    check('a resolved day keeps its outcome', o.days.find((d) => d.day === '2026-11-06').obs_arrival === false);
    check('days ≥ 3 ahead are flagged lower bounds', o.days.find((d) => d.day === '2026-11-13').lower_bound === true);

    const ctx = { runDays: new Set(o.run_days), lastRunMs: RUN, nowMs: NOW };
    const at = (iso) => dayRunState(Date.parse(`${iso}T00:00:00Z`), ctx);
    check('a day with a run is checked', at('2026-11-07') === 'checked');
    check('a hole inside the record is MISSED — drawn as a gap', at('2026-11-08') === 'missed');
    check('days before the record are not called gaps', at('2026-11-01') === 'before');
    check('tomorrow is future', at('2026-11-10') === 'future');
    const early = { runDays: new Set(['2026-11-08']), lastRunMs: NaN, nowMs: Date.parse('2026-11-09T05:00:00Z') };
    check('today before 06:30 UT is pending, not missed',
        dayRunState(Date.parse('2026-11-09T00:00:00Z'), early) === 'pending');
    check('today at noon with no run IS missed',
        dayRunState(Date.parse('2026-11-09T00:00:00Z'), { ...early, nowMs: Date.parse('2026-11-09T12:00:00Z') }) === 'missed');
}

// ── 4. Screened (glancing) events — never a Parkers Physics forecast ─────────
{
    const glancing = { event_id: 'PP-RT-2026-11-01T19:00:00-CME-001', donki_id: '2026-11-01T19:00:00-CME-001',
        launch: '2026-11-02T03:59:00Z', speed_kms: 357, half_deg: 27, lat_deg: 7, lon_deg: 31,
        forecasts: { 'ballistic-v1': { predicted: '2026-11-06T12:44:49Z' }, 'dbm-v1': { predicted: '2026-11-06T07:10:24Z' } },
        truth: { arrived: false } };
    const s = screenedEvent(glancing);
    check('real 11-02 CME (31.8° off-axis, 27° half-width) is screened on the DBM ETA',
        s && s.model === 'dbm-v1' && s.offAxisDeg > s.halfDeg && s.etas.length === 2, `${s?.offAxisDeg.toFixed(1)}° vs ${s?.halfDeg}°`);
    check('an event WITH a flux-rope forecast is not "screened"',
        screenedEvent({ ...glancing, forecasts: { ...glancing.forecasts, 'flux-rope-v1': { predicted: '2026-11-06T09:00:00Z' } } }) === null);
    check('an event with no forecast at all is not drawn', screenedEvent({ ...glancing, forecasts: {} }) === null);
    check('ENLIL is preferred when CCMC modelled it', screenedEvent({ ...glancing,
        forecasts: { ...glancing.forecasts, enlil: { predicted: '2026-11-06T02:00:00Z' } } }).model === 'enlil');
}

// ── 5. The route, for real, against a fake PostgREST ─────────────────────────
process.env.SUPABASE_URL = 'https://db.test';
process.env.SUPABASE_SERVICE_KEY = 'k';
const realNow = Date.now, realFetch = globalThis.fetch;
let db;
globalThis.fetch = async (url) => {
    const u = new URL(url);
    const table = u.pathname.replace('/rest/v1/', '');
    if (db.fail?.includes(table)) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => db[table] ?? [] };
};
const { default: handler } = await import('../api/cme/skill.js');
const call = async () => {
    const res = await handler(new Request('https://x.test/api/cme/skill?events=60'));
    return { status: res.status, body: await res.json() };
};
const EVENTS = [
    { event_id: 'PP-RT-G', donki_id: 'G', launch_time_utc: '2026-11-02T03:59:00Z', speed_kms_3d: 357,
      half_width_deg: 27, direction_lat_deg: 7, direction_lon_deg: 31,
      cme_arrival_forecasts: [
          { model_id: 'dbm-v1', issued_at: '2026-11-02T06:30:32Z', predicted_arrival_utc: '2026-11-06T07:10:24Z' },
          { model_id: 'ballistic-v1', issued_at: '2026-11-02T06:30:32Z', predicted_arrival_utc: '2026-11-06T12:44:49Z' }],
      cme_l1_observations: [{ arrived: false, shock_arrival_utc: null }] },
    { event_id: 'PP-RT-F', donki_id: 'F', launch_time_utc: '2026-10-12T04:03:00Z', speed_kms_3d: 618,
      half_width_deg: 36, direction_lat_deg: -1, direction_lon_deg: -28,
      cme_arrival_forecasts: [
          { model_id: 'flux-rope-v1', issued_at: '2026-10-13T06:30:33Z', predicted_arrival_utc: '2026-10-14T17:00:00Z',
            inputs: { p_hit: 0.62, min_bz_p50: -7 } }],
      cme_l1_observations: [{ arrived: false, shock_arrival_utc: null }] },
];
const HB = { last_success_at: '2026-11-09T06:30:35Z', last_failure_at: null, last_failure_reason: null,
    last_source: '44 CMEs screened · 2 Earth-relevant · 0 new locks · flux-rope idle (no Earth-directed CME) · outlook issued',
    consecutive_fail: 0 };

Date.now = () => NOW;
db = { cme_model_skill: [], cme_events: EVENTS, pipeline_heartbeat: [HB], cme_outlook_issues: OUTLOOK_ROWS };
let r = await call();
check('healthy: 200, freshness fresh, updated == the RUN time (not the request time)',
    r.status === 200 && r.body.freshness === 'fresh' && r.body.data.updated === '2026-11-09T06:30:35.000Z'
    && r.body.data.served !== r.body.data.updated, r.body.data.updated);
check('ledger block carries the run\'s own line', r.body.data.ledger.basis === 'heartbeat'
    && /44 CMEs screened/.test(r.body.data.ledger.summary) && r.body.data.ledger.state === 'fresh');
check('outlook days + run days are served', r.body.data.outlook.days.length >= 9
    && r.body.data.outlook.run_days.at(-1) === '2026-11-09');
check('events carry direction (why a CME is glancing)', r.body.data.events[0].half_deg === 27
    && r.body.data.events[0].lon_deg === 31);
check('daily probe PASSES on a quiet, healthy ledger', checkLedgerPayload(r.body, NOW).length === 0,
    checkLedgerPayload(r.body, NOW).join(' | '));
{
    const { normalizeCmePayload, screenedForUtcDay, formatOdds } = await import('../js/cme-forecast-page.js');
    const n = normalizeCmePayload(r.body);
    check('page: one flux-rope forecast, one screened glancing CME — kept apart',
        n.events.length === 1 && n.events[0].id === 'PP-RT-F' && n.screened.length === 1 && n.screened[0].id === 'PP-RT-G');
    check('page: screened CME lands on its baseline day',
        screenedForUtcDay(n.screened, Date.parse('2026-11-06T00:00:00Z')).length === 1);
    check('page: updatedAt is the cron run', n.updatedAt === Date.parse('2026-11-09T06:30:35Z'));
    const d13 = n.outlookDays.get(Date.parse('2026-11-13T00:00:00Z'));
    check('page: odds print with ≥ on lower-bound days', formatOdds(d13) === '≥15%', formatOdds(d13));
    check('page: tiny odds print as <1 %, zero as 0 %', formatOdds({ p_arrival: 0.001 }) === '<1%'
        && formatOdds({ p_arrival: 0 }) === '0%' && formatOdds({ p_arrival: null }) === null);
}

// NEGATIVE CONTROL — the pre-fix payload shape (updated = now, no ledger).
check('control: the OLD payload fails the probe (it could never be stale)',
    checkLedgerPayload({ data: { updated: new Date(NOW).toISOString(), models: [], events: [] } }, NOW).length === 1);

// The cron stops: same tables, three days later.
Date.now = () => NOW + 3 * DAY;
r = await call();
check('cron dead 3 days: still 200, freshness expired, ledger says so',
    r.status === 200 && r.body.freshness === 'expired' && r.body.data.ledger.state === 'expired'
    && r.body.data.updated === '2026-11-09T06:30:35.000Z');
check('…and the probe FAILS naming the age', /h ago/.test(checkLedgerPayload(r.body, NOW + 3 * DAY)[0] ?? ''),
    checkLedgerPayload(r.body, NOW + 3 * DAY)[0]);

// One missed run.
Date.now = () => NOW + 16 * H;      // 31 h after the run
r = await call();
check('one missed run: freshness stale', r.body.freshness === 'stale');

// The run is failing (ran today, but the lock threw).
Date.now = () => NOW;
db = { cme_model_skill: [], cme_events: EVENTS, cme_outlook_issues: OUTLOOK_ROWS,
    pipeline_heartbeat: [{ ...HB, last_success_at: '2026-11-08T06:30:35Z', last_failure_at: '2026-11-09T06:30:35Z',
        last_failure_reason: 'lock_resolve_failed: DONKI CMEAnalysis: non-JSON', consecutive_fail: 1 }] };
r = await call();
check('failing run: stale + reason exposed, stale summary withheld', r.body.freshness === 'stale'
    && r.body.data.ledger.summary === null && /non-JSON/.test(r.body.data.ledger.last_failure_reason));
check('…probe FAILS on a failing run', checkLedgerPayload(r.body, NOW).some((p) => /failing/.test(p)));

// First deploy: no heartbeat row yet — the newest outlook issue stands in.
db = { cme_model_skill: [], cme_events: EVENTS, pipeline_heartbeat: [], cme_outlook_issues: OUTLOOK_ROWS };
r = await call();
check('no heartbeat yet: last run falls back to the newest locked issue',
    r.body.data.ledger.basis === 'outlook-issue' && r.body.data.ledger.last_run === '2026-11-09T06:30:32.000Z'
    && r.body.freshness === 'fresh');

// The optional reads fail: the forecast ledger must still be served.
db = { cme_model_skill: [], cme_events: EVENTS, fail: ['pipeline_heartbeat', 'cme_outlook_issues'] };
r = await call();
check('heartbeat + outlook unreadable: events still served, freshness expired (cannot vouch)',
    r.status === 200 && r.body.data.events.length === 2 && r.body.data.ledger.basis === 'none'
    && r.body.freshness === 'expired' && r.body.data.outlook.days.length === 0);

// Outlook stopped being issued while the ledger still runs.
db = { cme_model_skill: [], cme_events: EVENTS, pipeline_heartbeat: [HB],
    cme_outlook_issues: OUTLOOK_ROWS.filter((x) => x.issue_day !== '2026-11-09') };
r = await call();
check('probe FAILS when today\'s outlook issue is missing',
    checkLedgerPayload(r.body, NOW).some((p) => /newest outlook issue is 2026-11-07/.test(p)));

Date.now = realNow; globalThis.fetch = realFetch;

// ── 6. The daily probe is actually scheduled, after the cron ─────────────────
{
    const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
    const cron = vercel.crons.find((c) => c.path === '/api/cron/validation-rerun');
    const wf = readFileSync(new URL('../.github/workflows/cme-ledger-daily.yml', import.meta.url), 'utf8');
    const m = wf.match(/cron:\s*'(\d+) (\d+) \* \* \*'/);
    const [cm, ch] = cron.schedule.split(' ').map(Number);
    check('validation-rerun is a DAILY cron', /^\d+ \d+ \* \* \*$/.test(cron.schedule), cron.schedule);
    check('the probe workflow runs daily, ≥ 45 min after the cron',
        m && (Number(m[2]) * 60 + Number(m[1])) - (ch * 60 + cm) >= 45, m?.[0]);
    check('…and runs scripts/check-cme-ledger.mjs', /scripts\/check-cme-ledger\.mjs/.test(wf));
}

console.log(failures ? `\n${failures} failure(s)` : '\ncme-ledger-status: all checks passed');
process.exit(failures ? 1 : 0);
