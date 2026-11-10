/**
 * Node gate for js/status-health.js — how status.html scores an incoming feed.
 *
 * The rules lived inline in status.html, untested, until 2026-11-09. What
 * this pins:
 *   · a route's OWN freshness statement beats the age heuristics AND the
 *     freshnessExempt short-circuit (NEGATIVE CONTROL: the same body without
 *     the statement scores healthy)
 *   · a degraded row says WHY: reasons / degraded_reason / missing env are
 *     printed, with a hint naming the fix for the tokens we know
 *     (the Climalytix archive's first day read only "freshness=expired")
 *   · a healthy body's `note` is documentation, never a diagnosis
 *   · the age ladder reads every stamp our routes use, incl. NOAA arrays
 *   · heartbeat: fallback source = degraded, streak ≥ 3 = critical, a missing
 *     row is critical, and the reason travels with the verdict
 *   · upstreams: an edge 403 on a browser-direct feed is NOT a failure, and
 *     the browser's own fetch decides it when there is one
 *   · the overview counts 'info' rows as neither healthy nor an issue
 *   · mapLimit keeps order and never exceeds its limit
 *   · the two real production bodies of 2026-11-09 score as they should
 */
import assert from 'node:assert/strict';
import {
    endpointHealth, heartbeatHealth, upstreamHealth, gibsHealth, describeBody, reasonHint,
    probeAgeSeconds, summarize, fmtSpan, fmtAgeSec, fmtRel, mapLimit, LEVEL_COLORS,
} from '../js/status-health.js';
import { HEARTBEAT_PIPELINES, PIPELINES } from '../js/pipeline-registry.js';

const NOW = Date.UTC(2026, 10, 9, 19, 0, 0);
const iso = (minAgo) => new Date(NOW - minAgo * 60_000).toISOString();
const spec = (over = {}) => ({ warnAgeS: 1800, critAgeS: 7200, freshnessExempt: false, ...over });
const probe = (over = {}) => ({ spec: spec(over.spec), status: 200, body: {}, netErr: null, ageSec: 60, ...over, ...(over.spec ? { spec: spec(over.spec) } : {}) });

// ── endpointHealth: transport failures ──────────────────────────────────────
assert.deepEqual(endpointHealth(probe({ netErr: 'Failed to fetch', status: null })),
    { level: 'crit', label: 'network error', detail: 'Failed to fetch' });
assert.equal(endpointHealth(probe({ netErr: 'timed out after 8 s', status: null })).label, 'timeout');
assert.equal(endpointHealth(probe({ status: null })).label, 'no response');
assert.equal(endpointHealth(probe({ status: 503, body: { error: 'cache_empty' } })).label, 'HTTP 503 · cache_empty');
assert.match(endpointHealth(probe({ status: 503, body: { error: 'cache_empty', reasons: ['cache_empty'] } })).detail,
    /cron that fills this cache/);
assert.equal(endpointHealth(probe({ status: 400 })).level, 'crit');
assert.equal(endpointHealth(probe({ body: { error: 'supabase_not_configured', missing: ['SUPABASE_URL'] } })).detail,
    'missing env: SUPABASE_URL');

// ── endpointHealth: the route's own freshness statement ─────────────────────
{
    // The REAL production body of /api/climalytix/nwp-field on 2026-11-09.
    const body = { source: 'climalytix-gfs', role: 'archive', grid: '0p25', freshness: 'expired',
        reasons: ['no_run_published'], generated_at: iso(0),
        note: 'Our own GFS archive is unavailable for this request; nothing is substituted.', values: null };
    const h = endpointHealth(probe({ body, ageSec: probeAgeSeconds(body, NOW) }));
    assert.equal(h.level, 'crit');
    assert.equal(h.label, 'freshness=expired');
    assert.match(h.detail, /^no_run_published — /, 'the reason token is printed verbatim, first');
    assert.match(h.detail, /climalytix-ingest/, 'and the hint names what to run');
    // NEGATIVE CONTROL: the same fresh body without the statement is healthy.
    const { freshness, reasons, ...quiet } = body;
    assert.equal(endpointHealth(probe({ body: quiet, ageSec: 0 })).level, 'ok');
}
{
    // freshness beats freshnessExempt (CLAUDE.md §8) — both levels.
    const exempt = { freshnessExempt: true };
    assert.equal(endpointHealth(probe({ spec: exempt, ageSec: null, body: { freshness: 'stale', reasons: ['fallback-source'] } })).level, 'warn');
    assert.equal(endpointHealth(probe({ spec: exempt, ageSec: null, body: { freshness: 'expired' } })).level, 'crit');
    assert.equal(endpointHealth(probe({ spec: exempt, ageSec: null, body: { freshness: 'fresh' } })).level, 'ok');
    assert.equal(endpointHealth(probe({ spec: exempt, ageSec: null, body: null })).level, 'ok');
    // …and beats a young age.
    assert.equal(endpointHealth(probe({ ageSec: 5, body: { freshness: 'stale' } })).label, 'freshness=stale');
}
// A degraded body with no reasons falls back to its note; a healthy one never prints it.
assert.equal(endpointHealth(probe({ body: { freshness: 'stale', note: 'reference markers served' } })).detail, 'reference markers served');
assert.equal(endpointHealth(probe({ body: { note: 'Per-site, 12 h edge cache.' } })).detail, '');
assert.equal(endpointHealth(probe({ body: { freshness: 'stale', degraded_reason: 'jupiter vector missing' } })).detail, 'jupiter vector missing');

// ── endpointHealth: age thresholds ──────────────────────────────────────────
assert.equal(endpointHealth(probe({ ageSec: null })).label, 'no freshness info');
assert.equal(endpointHealth(probe({ ageSec: 1800 })).level, 'ok', 'at the warn line is still healthy');
assert.equal(endpointHealth(probe({ ageSec: 1801 })).label, 'warning (stale)');
assert.equal(endpointHealth(probe({ ageSec: 7201 })).label, 'critical (stale)');
assert.match(endpointHealth(probe({ ageSec: 7201 })).detail, /older than 2h/);

// ── probeAgeSeconds ─────────────────────────────────────────────────────────
assert.equal(probeAgeSeconds(null, NOW), null);
assert.equal(probeAgeSeconds({}, NOW), null);
assert.equal(probeAgeSeconds({ age_seconds: 42 }, NOW), 42);
assert.equal(probeAgeSeconds({ age_min: 2.5 }, NOW), 150);
assert.equal(probeAgeSeconds({ fetched_at: iso(10) }, NOW), 600);
assert.equal(probeAgeSeconds({ fetched: iso(1) }, NOW), 60);
assert.equal(probeAgeSeconds({ generated_at: iso(3) }, NOW), 180);
assert.equal(probeAgeSeconds({ updated: iso(4) }, NOW), 240);
assert.equal(probeAgeSeconds({ data: { updated: iso(5) } }, NOW), 300);
assert.equal(probeAgeSeconds({ fetched_at: 'not a date', generated_at: iso(3) }, NOW), 180, 'an unparseable stamp falls through to the next');
assert.equal(probeAgeSeconds({ age_seconds: 7, fetched_at: iso(99) }, NOW), 7, 'an explicit age wins');
assert.equal(probeAgeSeconds([{ time_tag: iso(30) }, { time_tag: iso(2) }], NOW), 120, 'NOAA arrays: the newest sample');
assert.equal(probeAgeSeconds([], NOW), null);
assert.equal(probeAgeSeconds({ fetched_at: new Date(NOW + 60_000).toISOString() }, NOW), 0, 'a clock-skewed future stamp is age 0, never negative');

// ── describeBody / reasonHint ───────────────────────────────────────────────
assert.equal(describeBody(null), '');
assert.equal(describeBody([1, 2]), '');
assert.equal(reasonHint('something_new'), null);
assert.match(reasonHint('r2_not_configured'), /R2_\* secrets/);
assert.match(reasonHint('tile_read_failed: tile range HTTP 403'), /byte-range/);
assert.equal(describeBody({ reasons: ['something_new'] }), 'something_new', 'an unknown token is printed as is');
assert.equal(describeBody({ reasons: 'single-string' }), 'single-string');
assert.ok(describeBody({ reasons: ['x'.repeat(900)] }).length <= 400, 'a runaway reason cannot blow the table up');

// ── heartbeatHealth ─────────────────────────────────────────────────────────
{
    const sw = HEARTBEAT_PIPELINES.find((p) => p.key === 'solar_wind');
    const wg = HEARTBEAT_PIPELINES.find((p) => p.key === 'weather_grid');
    const row = (over = {}) => ({ last_success_at: iso(1), consecutive_fail: 0, last_source: 'open-meteo:720x360', ...over });
    assert.equal(heartbeatHealth(null, sw, NOW).level, 'crit');
    assert.equal(heartbeatHealth(null, sw, NOW).label, 'no heartbeat row');
    assert.equal(heartbeatHealth({ last_failure_reason: 'r2_not_configured' }, sw, NOW).label, 'never succeeded');
    assert.equal(heartbeatHealth({ last_failure_reason: 'r2_not_configured' }, sw, NOW).detail, 'r2_not_configured');
    assert.deepEqual(heartbeatHealth(row(), sw, NOW), { level: 'ok', label: 'healthy', detail: '' });
    assert.equal(heartbeatHealth(row({ last_success_at: iso(sw.warnMin + 1) }), sw, NOW).level, 'warn');
    assert.equal(heartbeatHealth(row({ last_success_at: iso(sw.critMin + 1) }), sw, NOW).level, 'crit');
    const streak = heartbeatHealth(row({ consecutive_fail: 3, last_failure_reason: 'HTTP 429' }), sw, NOW);
    assert.equal(streak.level, 'crit');
    assert.match(streak.detail, /3 failures in a row — HTTP 429/);
    assert.match(heartbeatHealth(row({ consecutive_fail: 1, last_failure_reason: 'HTTP 414' }), sw, NOW).detail, /HTTP 414/);
    // The 30-day silent outage: succeeding on the fallback is NOT healthy.
    const fb = heartbeatHealth(row({ last_source: 'met-norway:72x36' }), wg, NOW);
    assert.equal(fb.level, 'warn');
    assert.equal(fb.label, 'degraded · fallback source');
    assert.match(fb.detail, /met-norway:72x36, not open-meteo/);
    assert.equal(heartbeatHealth(row(), wg, NOW).level, 'ok', 'NEGATIVE CONTROL: the primary source is healthy');
    // A streak outranks the fallback wording; staleness outranks both.
    assert.equal(heartbeatHealth(row({ last_source: 'met-norway:72x36', consecutive_fail: 5 }), wg, NOW).level, 'crit');
}

// ── upstreamHealth ──────────────────────────────────────────────────────────
{
    const edge = { source: 'donki-cme', edge_authoritative: true };
    assert.equal(upstreamHealth({ ...edge, ok: true }).level, 'ok');
    assert.equal(upstreamHealth({ ...edge, ok: false, http_status: 503 }).label, 'HTTP 503');
    assert.equal(upstreamHealth({ ...edge, ok: false, error: 'expected JSON, got text/html' }).label, 'expected JSON, got text/html');
    // NOAA SWPC 403s the Vercel edge by design: that is not a failure…
    const swpc = { source: 'swpc-kp', edge_authoritative: false, ok: false, http_status: 403 };
    assert.equal(upstreamHealth(swpc).level, 'info');
    // …the browser's own fetch is what decides it.
    assert.equal(upstreamHealth(swpc, { ok: true, status: 200 }).level, 'ok');
    assert.match(upstreamHealth(swpc, { ok: true, status: 200 }).detail, /edge: HTTP 403/);
    const down = upstreamHealth(swpc, { ok: false, status: null, error: 'blocked or unreachable' });
    assert.equal(down.level, 'crit');
    assert.equal(down.label, 'blocked or unreachable');
    assert.equal(upstreamHealth({ ...swpc, ok: true }, { ok: false, status: 500 }).label, 'HTTP 500',
        'an edge success does not excuse a browser failure');
}

// ── gibsHealth ──────────────────────────────────────────────────────────────
assert.equal(gibsHealth({ ok: true, status: 200 }).level, 'ok');
assert.equal(gibsHealth({ ok: false, status: 404 }).label, 'retired/renamed (404)');
assert.equal(gibsHealth({ ok: false, status: null, netErr: 'Failed to fetch' }).level, 'warn');
assert.equal(gibsHealth({ ok: false, status: 502 }).level, 'crit');

// ── summarize ───────────────────────────────────────────────────────────────
{
    const it = (group, label, level) => ({ group, id: label, label, health: { level, label: level, detail: '' } });
    const sum = summarize([
        it('endpoint', 'b-warn', 'warn'), it('endpoint', 'a-ok', 'ok'), it('upstream', 'swpc', 'info'),
        it('heartbeat', 'z-crit', 'crit'), it('endpoint', 'a-crit', 'crit'), it('gibs', 'a-warn', 'warn'),
    ]);
    assert.deepEqual([sum.ok, sum.warn, sum.crit, sum.info, sum.total, sum.scored], [1, 2, 2, 1, 6, 5]);
    assert.deepEqual(sum.issues.map((x) => x.label), ['a-crit', 'z-crit', 'b-warn', 'a-warn'],
        'issues: down before degraded, then by group and name; ok and info are never issues');
    assert.deepEqual(summarize([]).issues, []);
}

// ── formatting ──────────────────────────────────────────────────────────────
assert.equal(fmtSpan(45), '45s');
assert.equal(fmtSpan(600), '10m');
assert.equal(fmtSpan(3 * 3600), '3h');
assert.equal(fmtSpan(5 * 86400), '5d');
assert.equal(fmtSpan(NaN), '—');
assert.equal(fmtAgeSec(null), '—');
assert.equal(fmtAgeSec(120), '2m ago');
assert.equal(fmtRel(null, NOW), 'never');
assert.equal(fmtRel('garbage', NOW), 'never');
assert.equal(fmtRel(iso(0.2), NOW), 'just now');
assert.equal(fmtRel(iso(45), NOW), '45m ago');
assert.equal(fmtRel(iso(180), NOW), '3h ago');
for (const level of ['ok', 'warn', 'crit', 'info']) assert.match(LEVEL_COLORS[level], /^#[0-9a-f]{6}$/);

// ── mapLimit ────────────────────────────────────────────────────────────────
{
    let inFlight = 0, peak = 0;
    const ticks = [];
    const out = await mapLimit([5, 1, 4, 2, 3, 0, 6], 3, async (x) => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, x * 3));
        inFlight--;
        return x * 10;
    }, (done, total) => ticks.push(`${done}/${total}`));
    assert.deepEqual(out, [50, 10, 40, 20, 30, 0, 60], 'results keep input order');
    assert.equal(peak, 3, 'never more than the limit in flight');
    assert.equal(ticks.at(-1), '7/7');
    assert.deepEqual(await mapLimit([], 4, async () => 1), []);
}

// ── Every registry entry can be scored (no undefined thresholds reach the page) ──
for (const p of PIPELINES) {
    const h = endpointHealth({ spec: p, status: 200, body: { fetched_at: iso(0) }, netErr: null, ageSec: 0 });
    assert.equal(h.level, 'ok', `${p.id}: a fresh 200 is healthy`);
    assert.ok(p.freshnessExempt || (Number.isFinite(p.warnAgeS) && Number.isFinite(p.critAgeS)),
        `${p.id}: needs warnAgeS/critAgeS or freshnessExempt, or an old body can never go amber`);
}

console.log('status-health: endpoint, heartbeat, upstream, GIBS verdicts + reasons, age ladder, overview and mapLimit passed');
