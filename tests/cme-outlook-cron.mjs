// tests/cme-outlook-cron.mjs — hermetic run of the two cron paths added
// 2026-10-14 to api/cron/validation-rerun.js:
//   · the SHADOW lock (flux-rope-v1-src, source-region rope prior) beside
//     the unchanged flux-rope-v1 lock;
//   · the eruption OUTLOOK (cme-outlook-v0): issue + lock with
//     ignore-duplicates, resolution from cme_l1_observations + L1 coverage,
//     Brier scoring; and the 'table_missing' path (migration not applied)
//     which must not disturb the arrival ledger.
// Fake PostgREST + fake DONKI/SWPC; the committed WASM runs for real.
//
//   node tests/cme-outlook-cron.mjs

let failures = 0;
function check(label, ok, detail = '') {
    if (ok) console.log(`  ok  ${label}${detail ? ` — ${detail}` : ''}`);
    else { failures++; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

const NOW = Date.parse('2026-10-14T06:30:00Z');
const realNow = Date.now;
Date.now = () => NOW;

const LAUNCH = '2026-10-14T00:00:00Z';
const CME = { associatedCMEID: '2026-10-13T23:24:00-CME-001', time21_5: LAUNCH, speed: 1100,
    latitude: 5, longitude: 0, halfAngle: 45, isMostAccurate: true, type: 'O' };
const FLR = { flrID: '2026-10-13T22:40:00-FLR-001', classType: 'X1.4', beginTime: '2026-10-13T22:40Z',
    peakTime: '2026-10-13T23:05Z', sourceLocation: 'S16W08', activeRegionNum: 14321 };
const REGIONS = [
    { region: 14321, observed_date: '2026-10-14', location: 'S16W08', area: 520,
      m_flare_probability: 65, x_flare_probability: 20 },
    { region: 14325, observed_date: '2026-10-14', location: 'N10E35', area: 180,
      m_flare_probability: 25, x_flare_probability: 5 },
];

// Two prior locks on the resolved event PP-RT-A (shock 10-11T10:00, min Bz
// −14): v1 says Bz stays mild, the shadow says it goes south — the scored
// run must carry BOTH on the same event under the same selection rule.
const lockFor = (model_id, minBzP50, p10) => ({
    event_id: 'PP-RT-A', model_id, issued_at: '2026-10-10T06:30:00Z',
    predicted_arrival_utc: '2026-10-11T08:00:00Z', arrival_window_early: '2026-10-11T00:00:00Z',
    arrival_window_late: '2026-10-11T16:00:00Z', predicted_hit: true, predicted_speed_at_l1: 640,
    inputs: { p_hit: 0.7, p10, p20: p10 / 3, min_bz_p50: minBzP50, min_bz_p5: minBzP50 - 10,
        launch: '2026-10-10T02:00:00Z', epoch: '2026-10-10T02:00:00Z', v0_kms: 1000,
        w_eff_kms: 400, gamma_eff_per_km: 2e-8, sig_v0_kms: 150, train: ['A'], ropeIndex: 0 },
});

function makeDb() {
    return {
        cme_arrival_forecasts: [lockFor('flux-rope-v1', -4, 0.2), lockFor('flux-rope-v1-src', -15, 0.6)],
        cme_l1_observations: [
            { event_id: 'PP-RT-A', arrived: true, shock_arrival_utc: '2026-10-11T10:00:00Z', observed_bz_min_nt: -14 },
            { event_id: 'PP-RT-OLD', arrived: true, shock_arrival_utc: '2026-10-11T18:00:00Z', observed_bz_min_nt: -30 },
        ],
        cme_events: [
            { event_id: 'PP-RT-A', launch_time_utc: '2026-10-10T02:00:00Z' },     // after the 10-09 issue
            { event_id: 'PP-RT-OLD', launch_time_utc: '2026-10-08T00:00:00Z' },   // before it: never counts
        ],
        cme_outlook_issues: [
            { id: 1, model_id: 'cme-outlook-v0', issued_at: '2026-10-09T06:30:00Z', valid_day: '2026-10-11', lead_days: 2, p_arrival: 0.3, p_geo: 0.2, resolved_at: null },
            { id: 2, model_id: 'cme-outlook-v0', issued_at: '2026-10-09T06:30:00Z', valid_day: '2026-10-12', lead_days: 3, p_arrival: 0.1, p_geo: 0.05, resolved_at: null },
            { id: 3, model_id: 'cme-outlook-v0', issued_at: '2026-10-09T06:30:00Z', valid_day: '2026-10-10', lead_days: 1, p_arrival: 0.05, p_geo: 0.02, resolved_at: null },
        ],
        // Good-quality 1-min rows per day (HEAD count=exact reads this).
        coverage: { '2026-10-10': 400, '2026-10-11': 1400, '2026-10-12': 1300 },
        validation_runs: [],
    };
}

let db, tableMissing, sent;
function filt(rows, params) {
    return rows.filter((r) => {
        for (const [k, v] of params) {
            if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k)) continue;
            const [op, ...rest] = v.split('.'); const val = rest.join('.');
            const x = r[k];
            const cmp = (a) => (/(_utc|_at|_day)$/.test(k) || k === 't') ? Date.parse(a) : a;
            if (op === 'eq' && String(x) !== val) return false;
            if (op === 'in' && !val.slice(1, -1).split(',').map(decodeURIComponent).includes(x)) return false;
            if (op === 'gte' && !(cmp(x) >= cmp(val))) return false;
            if (op === 'lte' && !(cmp(x) <= cmp(val))) return false;
            if (op === 'lt' && !(cmp(x) < cmp(val))) return false;
            if (op === 'is' && val === 'null' && x != null) return false;
            if (op === 'not' && val === 'is.null' && x == null) return false;
        }
        return true;
    });
}
const json = (body, status = 200, headers = {}) => ({
    ok: status < 300, status, headers: { get: (h) => headers[h.toLowerCase()] ?? 'application/json' },
    json: async () => body, text: async () => JSON.stringify(body),
});

globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.host === 'ccmc.gsfc.nasa.gov') {
        const p = u.pathname.split('/').pop();
        if (p === 'CMEAnalysis') return json([CME]);
        if (p === 'FLR') return json([FLR]);
        return json([]);
    }
    if (u.host === 'api.nasa.gov' || u.host === 'kauai.ccmc.gsfc.nasa.gov') throw new Error('old host');
    if (u.host === 'services.swpc.noaa.gov') {
        if (u.pathname.endsWith('/solar_regions.json')) return json(REGIONS);
        throw new Error('rtsw egress blocked (test)');
    }
    if (u.host === 'www.lmsal.com') throw new Error('hek blocked (test)');
    if (u.host !== 'db.test') throw new Error(`unexpected fetch ${url}`);
    const table = u.pathname.replace('/rest/v1/', '');
    if (table.startsWith('rpc/')) return json([]);
    const method = init.method ?? 'GET';
    if (table === 'cme_outlook_issues' && tableMissing) {
        return json({ code: 'PGRST205', message: "Could not find the table 'public.cme_outlook_issues'" }, 404);
    }
    if (method === 'HEAD' && table === 'sw_geomag_dataset') {
        const day = u.searchParams.get('t').slice(4, 14);
        const n = db.coverage[day] ?? 0;
        return json(null, 206, { 'content-range': `0-0/${n}` });
    }
    if (method === 'GET') {
        let rows = filt(db[table] ?? [], u.searchParams);
        const off = Number(u.searchParams.get('offset') ?? 0);
        return json(rows.slice(off, off + 1000));
    }
    if (method === 'POST') {
        const list = [].concat(JSON.parse(init.body));
        sent.push({ table, url: String(url), prefer: init.headers?.Prefer ?? '', rows: list });
        if (table === 'cme_outlook_issues') {
            for (const r of list) {
                if (!db.cme_outlook_issues.some((x) => x.model_id === r.model_id && x.issue_day === r.issue_day && x.valid_day === r.valid_day)) {
                    db.cme_outlook_issues.push({ id: db.cme_outlook_issues.length + 1, resolved_at: null, ...r });
                }
            }
        } else if (db[table]) db[table].push(...list);
        return json([], 201);
    }
    if (method === 'PATCH') {
        const body = JSON.parse(init.body);
        for (const r of filt(db[table] ?? [], u.searchParams)) Object.assign(r, body);
        sent.push({ table, patch: true, query: u.search, body });
        return json([], 204);
    }
    throw new Error(`unhandled ${method} ${url}`);
};

process.env.SUPABASE_URL = 'https://db.test';
process.env.SUPABASE_SERVICE_KEY = 'service';
process.env.CRON_SECRET = 'secret';
const realLog = console.log, realErr = console.error;
const quiet = (f) => (...a) => { if (!String(a[0]).startsWith('validation-rerun')) f(...a); };
const { default: handler } = await import('../api/cron/validation-rerun.js');
async function run() {
    sent = [];
    console.log = quiet(realLog); console.error = quiet(realErr);
    let out;
    await handler({ headers: { authorization: 'Bearer secret' } },
        { status() { return this; }, json(b) { out = b; return this; } });
    console.log = realLog; console.error = realErr;
    return out;
}

// ── Run 1: table present ─────────────────────────────────────────────────────
db = makeDb(); tableMissing = false;
let out = await run();
const fr = out.fluxRope ?? {};
const locks = sent.filter((s) => s.table === 'cme_arrival_forecasts').flatMap((s) => s.rows);
const v1 = locks.filter((r) => r.model_id === 'flux-rope-v1');
const src = locks.filter((r) => r.model_id === 'flux-rope-v1-src');
check('flux-rope-v1 locked as before, with no source prior', v1.length === 1 && !('source_prior' in v1[0].inputs),
    `${v1.length} rows`);
check('shadow flux-rope-v1-src locked beside it', src.length === 1 && fr.shadow?.priors === 1 && fr.shadow?.locked === 1,
    JSON.stringify(fr.shadow));
check('shadow row carries the S-hemisphere prior (H +1, cycle 25)',
    src[0]?.inputs?.source_prior?.handedness === 1 && src[0].inputs.source_prior.cycle === 25,
    JSON.stringify(src[0]?.inputs?.source_prior));
check('shadow and v1 share the event, differ in Bz', src[0]?.event_id === v1[0]?.event_id
    && src[0].inputs.min_bz_p50 !== v1[0].inputs.min_bz_p50,
    `min Bz p50 v1 ${v1[0]?.inputs.min_bz_p50?.toFixed?.(1)} src ${src[0]?.inputs.min_bz_p50?.toFixed?.(1)}`);

const shadowRun = sent.filter((s) => s.table === 'validation_runs').flatMap((s) => s.rows)
    .find((r) => r.kind === 'flux-rope');
const sh = shadowRun?.metrics?.shadow;
check('scored run carries the shadow comparison on the same event', sh?.events === 1
    && sh.src.n === 1 && sh.v1.n === 1, JSON.stringify(sh));
check('…and it tells them apart (shadow called the −14 nT, v1 did not)',
    sh?.src.brier10 < sh?.v1.brier10 && sh?.src.minBzMaeNt < sh?.v1.minBzMaeNt,
    `Brier(−10) src ${sh?.src.brier10?.toFixed?.(3)} v1 ${sh?.v1.brier10?.toFixed?.(3)}`);

const ol = out.outlook ?? {};
const issue = sent.find((s) => s.table === 'cme_outlook_issues' && !s.patch);
check('outlook issued from SWPC regions', ol.issued?.regions === 2, JSON.stringify(ol.issued));
check('locked 7 rows, first-issue-wins (ignore-duplicates on the unique key)',
    issue?.rows.length === 7 && /ignore-duplicates/.test(issue.prefer)
    && /on_conflict=model_id,issue_day,valid_day/.test(issue.url));
const row = (id) => db.cme_outlook_issues.find((r) => r.id === id);
check('10-11: arrival of a CME launched after issue, Bz −14 ⇒ YES/YES (the pre-issue CME ignored)',
    row(1).obs_arrival === true && row(1).obs_geo === true && row(1).resolved_at);
check('10-12: not resolvable until 2 days after it ends', row(2).resolved_at == null);
check('10-10: quiet day with an L1 gap stays pending, noted',
    row(3).resolved_at == null && row(3).resolve_note === 'l1-coverage-gap');
check('Brier record scored', ol.scored?.n === 1 && ol.scored.arrival[0].lead === 2,
    JSON.stringify(ol.scored?.arrival?.map((b) => [b.lead, b.brier])));

// Two days later the 10-12 row resolves: quiet, with coverage ⇒ NO.
{
    const t = Date.parse('2026-10-15T06:30:00Z');
    Date.now = () => t;
    await run();
    check('10-12: quiet day with L1 coverage ⇒ NO (once resolvable)',
        row(2).obs_arrival === false && row(2).obs_geo === false && row(2).resolved_at);
    Date.now = () => NOW;
}

// Re-run the same day: nothing new is written over the record.
const before = db.cme_outlook_issues.length;
out = await run();
check('same-day re-run adds no outlook rows', db.cme_outlook_issues.length === before);

// ── Run 2: migration not applied ─────────────────────────────────────────────
db = makeDb(); tableMissing = true;
out = await run();
check('table missing ⇒ reason table_missing', out.outlook?.reason === 'table_missing', JSON.stringify(out.outlook));
check('…and the arrival ledger still locked', sent.some((s) => s.table === 'cme_arrival_forecasts'
    && s.rows.some((r) => r.model_id === 'flux-rope-v1')));

Date.now = realNow;
console.log(failures ? `\n${failures} failure(s)` : '\ncme-outlook-cron: all checks passed');
process.exit(failures ? 1 : 0);
