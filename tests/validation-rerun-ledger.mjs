// validation-rerun-ledger.mjs — hermetic end-to-end run of the daily
// validation cron's LEDGER block (api/cron/validation-rerun.js) against:
//   · a fake PostgREST that enforces what production does — the 1000-row
//     page cap and the validation_runs kind CHECK constraint;
//   · BOTH old DONKI hosts (api.nasa.gov, kauai.ccmc) answering 200 + CCMC's
//     HTML announcements page (the 2026-09-30 move);
//   · the MOVED CCMC host (ccmc.gsfc.nasa.gov/DONKI-API) serving the REAL Sep 2026 train (kinematics frozen
//     in the production locks, tests/fixtures/flux-rope-ledger-2026-09.json);
//   · the REAL L1 minute data for truth.
// The committed WASM runs the shared provider for real. No network:
//
//   node tests/validation-rerun-ledger.mjs
//
// Each production failure of 2026-08/10 is reproduced and must be survived.

import fs from 'node:fs';

let failures = 0;
function check(label, ok, detail = '') {
    if (ok) console.log(`  ok  ${label}${detail ? ` — ${detail}` : ''}`);
    else { failures++; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

const fx = JSON.parse(fs.readFileSync(
    new URL('./fixtures/flux-rope-ledger-2026-09.json', import.meta.url), 'utf8'));

// ── Clock: the real 2026-09-16 06:30 cron run ────────────────────────────────
const NOW = Date.parse('2026-09-16T06:30:40Z');
const realNow = Date.now;
Date.now = () => NOW;

// ── Fake database (production rows up to NOW) ────────────────────────────────
const AL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const minute = [];
for (const w of fx.bz.windows) {
    const t0 = Date.parse(w.startIso);
    for (let i = 0; i < w.n; i++) {
        const c = AL.indexOf(w.code[2 * i]) * 64 + AL.indexOf(w.code[2 * i + 1]);
        minute.push({ t: new Date(t0 + i * 60e3).toISOString(),
            sw_bz_nt: c === 4095 ? null : (c - 2048) / 10, sw_v_km_s: null,
            sw_flag: c === 4095 ? 'gap' : 'ok' });
    }
}
const byT = new Map(minute.map((r) => [Date.parse(r.t), r]));
for (const [iso, vs] of Object.entries(fx.vFirstHour)) {
    if (iso === 'note') continue;
    vs.forEach((v, i) => { const r = byT.get(Date.parse(iso) + i * 60e3); if (r) r.sw_v_km_s = v; });
}
// Pre-shock ambient: the measured 6 h median, laid down as flat minutes
// (the fixture stores the median, not the series — this exercises plumbing).
for (const [iso, v] of Object.entries(fx.upstreamV6h)) {
    if (iso === 'note') continue;
    const s = Date.parse(iso);
    for (let t = s - 6 * 3.6e6; t < s - 10 * 60e3; t += 60e3) {
        if (!byT.has(t)) { const r = { t: new Date(t).toISOString(), sw_bz_nt: 0, sw_v_km_s: v, sw_flag: 'ok' }; minute.push(r); byT.set(t, r); }
    }
}
minute.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));

const db = {
    sw_geomag_dataset: minute,
    cme_arrival_forecasts: [
        ...fx.locks.filter((l) => Date.parse(l.issued_at) < NOW).map((l, i) => ({ id: i + 1, model_id: 'flux-rope-v1', ...l })),
        ...fx.baselines.filter((l) => Date.parse(l.issued_at) < NOW).map((l, i) => ({ id: 1000 + i, ...l })),
    ],
    cme_l1_observations: fx.observations
        .filter((o) => !o.arrived || Date.parse(o.shock_arrival_utc) < NOW)
        .map((o) => ({ ...o, observed_bz_min_nt: null, observed_speed_kms: null })),
    cme_events: [],
    validation_runs: [],
};
const KIND_CHECK = ['backmap', 'recurrence', 'cme', 'flux-rope'];   // after the migration
const inserted = { validation_runs: [], cme_arrival_forecasts: [], patches: [] };
let maxPage = 0;

function applyFilters(rows, params) {
    let out = rows;
    for (const [k, v] of params) {
        if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k)) continue;
        const [op, ...rest] = v.split('.');
        const val = rest.join('.');
        const cmp = (a) => (k === 't' || k.endsWith('_at') || k.endsWith('_utc'))
            ? Date.parse(a) : a;
        out = out.filter((r) => {
            const x = r[k];
            if (op === 'eq') return String(x) === val;
            if (op === 'in') return val.slice(1, -1).split(',').map(decodeURIComponent).includes(x);
            if (op === 'gte') return cmp(x) >= cmp(val);
            if (op === 'lte') return cmp(x) <= cmp(val);
            if (op === 'lt') return cmp(x) < cmp(val);
            return true;
        });
    }
    return out;
}
const json = (body, status = 200) => ({
    ok: status < 300, status, headers: { get: () => 'application/json' },
    json: async () => body, text: async () => JSON.stringify(body),
});

// ── Fake upstreams ───────────────────────────────────────────────────────────
const trainCmes = new Map();
for (const l of fx.locks) {
    const id = l.event_id.replace(/^PP-RT-/, '');
    if (trainCmes.has(id)) continue;
    trainCmes.set(id, {
        associatedCMEID: id, time21_5: l.inputs.launch, speed: l.inputs.v0_kms,
        latitude: l.inputs.lat_deg, longitude: l.inputs.lon_deg, halfAngle: l.inputs.half_deg,
        isMostAccurate: true, type: 'S',
    });
}
const calls = { nasaHtml: 0, ccmc: 0, rtsw: 0 };
globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.host === 'api.nasa.gov' || u.host === 'kauai.ccmc.gsfc.nasa.gov') {
        calls.nasaHtml++;
        return { ok: true, status: 200, headers: { get: () => 'text/html' },
            text: async () => '<!DOCTYPE html><html><head><title>Service Update</title></head></html>',
            json: async () => { throw new SyntaxError(`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`); } };
    }
    if (u.host === 'ccmc.gsfc.nasa.gov' && u.pathname.startsWith('/DONKI-API/get/')) {
        calls.ccmc++;
        const path = u.pathname.split('/').pop();
        if (path === 'CMEAnalysis') {
            const lo = Date.parse(u.searchParams.get('startDate')), hi = Date.parse(u.searchParams.get('endDate')) + 864e5;
            return json([...trainCmes.values()].filter((c) => {
                const t = Date.parse(c.time21_5); return t >= lo && t < hi && t < NOW;
            }));
        }
        return json([]);
    }
    if (u.host === 'services.swpc.noaa.gov') { calls.rtsw++; throw new Error('egress blocked (test)'); }
    if (u.host === 'db.test') {
        const table = u.pathname.replace('/rest/v1/', '');
        if (table.startsWith('rpc/')) return json([]);
        const method = init.method ?? 'GET';
        if (method === 'GET') {
            const rows = applyFilters(db[table] ?? [], u.searchParams);
            const order = u.searchParams.get('order');
            if (order) {
                const [col, dir] = order.split(',')[0].split('.');
                rows.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (dir === 'desc' ? -1 : 1));
            }
            // PostgREST max-rows: whatever `limit` says, a page is ≤ 1000.
            const off = Number(u.searchParams.get('offset') ?? 0);
            const lim = Math.min(1000, Number(u.searchParams.get('limit') ?? 1000));
            const page = rows.slice(off, off + lim);
            maxPage = Math.max(maxPage, page.length);
            return json(page);
        }
        if (method === 'POST') {
            const body = JSON.parse(init.body);
            if (table === 'validation_runs' && !KIND_CHECK.includes(body.kind)) {
                return json({ code: '23514', message: 'validation_runs_kind_check' }, 400);
            }
            const list = Array.isArray(body) ? body : [body];
            if (inserted[table]) inserted[table].push(...list);
            return json([], 201);
        }
        if (method === 'PATCH') { inserted.patches.push({ table, query: u.search, body: JSON.parse(init.body) }); return json([], 204); }
    }
    throw new Error(`unexpected fetch ${url}`);
};

process.env.SUPABASE_URL = 'https://db.test';
process.env.SUPABASE_SERVICE_KEY = 'service';
process.env.CRON_SECRET = 'secret';
const logs = [];
const realLog = console.log, realErr = console.error;
console.log = (...a) => { if (String(a[0]).startsWith('validation-rerun')) logs.push(a.join(' ')); else realLog(...a); };
console.error = (...a) => { if (String(a[0]).startsWith('validation-rerun')) logs.push(a.join(' ')); else realErr(...a); };

const { default: handler } = await import('../api/cron/validation-rerun.js');
let out;
await handler({ headers: { authorization: 'Bearer secret' } },
    { status(c) { this.code = c; return this; }, json(b) { out = b; return this; } });
console.log = realLog; console.error = realErr;
Date.now = realNow;

// ── Assertions ───────────────────────────────────────────────────────────────
const fr = out?.fluxRope ?? {};
check('DONKI: old hosts\' HTML did not take the ledger down (moved CCMC host answered)',
    calls.nasaHtml >= 1 && calls.ccmc >= 1 && out?.donkiSources?.CMEAnalysis === 'ccmc'
    && !String(out?.cmeProgram?.reason ?? '').includes('Unexpected token'),
    JSON.stringify(out?.donkiSources));
check('ledger ran to its end (early-out is the missing wind buckets, as designed)',
    out?.reason === 'insufficient_wind_data' && !fr.reason, fr.reason ?? '');
check('PostgREST cap honoured: no page above 1000 rows, yet Bz truth resolved',
    maxPage <= 1000 && fr.bzResolved >= 4, `bzResolved ${fr.bzResolved}, max page ${maxPage}`);
const patched = inserted.patches.filter((p) => p.table === 'cme_l1_observations');
check('truth enrichment wrote the real min Bz back (e.g. −12.8 nT on 09-15)',
    patched.some((p) => p.body.observed_bz_min_nt === -12.8));
const runs = inserted.validation_runs.filter((r) => r.kind === 'flux-rope');
check('scored run inserted as kind=flux-rope (the CHECK now admits it)', runs.length === 1);
const m = runs[0]?.metrics ?? {};
check('scored run: leakage refused, lead time and paired skill recorded',
    m.rejected?.afterShock >= 1 && m.meanLeadH > 24 && m.paired?.events?.length >= 3,
    `rejected ${JSON.stringify(m.rejected)} lead ${m.meanLeadH?.toFixed?.(1)} h paired ${m.paired?.events?.length}`);
check('scored run: the drag inversion now retrieves on real events',
    m.inversionN >= 1 && m.dragRatioMedian > 1, `n ${m.inversionN} ratio ${m.dragRatioMedian?.toFixed?.(2)}`);
const newLocks = inserted.cme_arrival_forecasts.filter((r) => r.model_id === 'flux-rope-v1');
check('lock guard: no flux-rope row predicts an arrival before NOW, none for a resolved event',
    newLocks.every((r) => Date.parse(r.predicted_arrival_utc) > NOW)
    && newLocks.every((r) => !db.cme_l1_observations.some((o) => o.event_id === r.event_id)),
    `${newLocks.length} locked, dropped ${fr.droppedPostdiction} postdiction / ${fr.droppedResolved} resolved`);
check('telemetry: one structured ledger line was logged',
    logs.some((l) => l.startsWith('validation-rerun ledger {')), `${logs.length} line(s)`);

console.log(failures ? `\n${failures} failure(s)` : '\nall validation-rerun ledger checks passed');
process.exit(failures ? 1 : 0);
