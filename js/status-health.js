/**
 * status-health.js — how status.html scores an incoming data feed. PURE.
 * ═══════════════════════════════════════════════════════════════════════════
 * No DOM, no fetch, no ambient clock (every function takes `nowMs`), so the
 * rules are node-tested (tests/status-health.mjs). status.html only fetches
 * and draws; until 2026-11-09 these rules lived inline in the page, untested.
 *
 * FOUR KINDS OF FEED, ONE VERDICT SHAPE  { level, label, detail }
 *   heartbeat   a row of Supabase `pipeline_heartbeat` (cron-fed pipelines)
 *   endpoint    a same-origin /api/* route from js/pipeline-registry.js
 *   upstream    a third-party host from /api/health
 *   gibs        a NASA GIBS imagery layer
 *
 *   level   'ok' | 'warn' | 'crit' | 'info'
 *           'info' is NOT a failure and NOT a success: the check ran but
 *           cannot speak for users (an edge-side ping of a feed the browser
 *           fetches itself). It is never counted as an issue or as healthy.
 *   label   the short status word the table prints
 *   detail  WHY — the route's own `reasons` / `degraded_reason` / `note` /
 *           `missing` env, verbatim, plus a hint naming the fix where we
 *           know it. A red row that does not say why is half a status page:
 *           /api/climalytix/nwp read "freshness=expired" for its whole first
 *           day while the body said `no_run_published`.
 *
 * THE ORDER IN endpointHealth IS LOAD-BEARING: a route's OWN `freshness`
 * statement is read BEFORE the freshnessExempt short-circuit (CLAUDE.md §8 —
 * an exempt route's stale answer used to score green). The node gate pins it.
 */
import { isFallbackSource } from './pipeline-registry.js';

export const LEVEL_COLORS = { ok: '#4eff91', warn: '#ffd700', crit: '#ff5555', info: '#8899aa' };
export const LEVEL_WORDS  = { ok: 'healthy', warn: 'degraded', crit: 'down', info: 'not scored' };
const LEVEL_RANK = { crit: 0, warn: 1, info: 2, ok: 3 };

/**
 * What a known reason token means and who fixes it. Matched against each
 * reason string; the raw token is always printed too.
 */
export const REASON_HINTS = [
    [/^no_run_published/, 'no ingest run is in R2 yet — run the climalytix-ingest GitHub Action (and check its R2_* secrets)'],
    [/^r2_not_configured/, 'the R2_* secrets are not set on this deployment'],
    [/^manifest_read_failed/, 'the run manifest in R2 could not be read'],
    [/^tile_read_failed/, 'a tile byte-range read from R2 failed'],
    [/^fallback-source/, 'the primary upstream failed; a coarser fallback is being served'],
    [/^cache_empty/, 'the cron that fills this cache has not written a row'],
    [/^supabase_not_configured/, 'SUPABASE_URL / service key missing on this deployment'],
];

export function reasonHint(reason) {
    const s = String(reason ?? '');
    for (const [re, hint] of REASON_HINTS) if (re.test(s)) return hint;
    return null;
}

const asList = (x) => (Array.isArray(x) ? x : x == null || x === '' ? [] : [x]).map(String);

/**
 * The WHY of a degraded body, from the fields our routes actually emit:
 * reasons[] · degraded_reason · missing[] (env) · error/message · note.
 * `note` is included only when the body is degraded — on a healthy body it
 * is documentation, not a diagnosis.
 */
export function describeBody(body, { degraded = false } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
    const parts = [];
    const reasons = [...asList(body.reasons), ...asList(body.degraded_reason)];
    for (const r of reasons) {
        const hint = reasonHint(r);
        parts.push(hint ? `${r} — ${hint}` : r);
    }
    if (Array.isArray(body.missing) && body.missing.length) parts.push(`missing env: ${body.missing.join(', ')}`);
    if (body.error && typeof body.message === 'string') parts.push(body.message);
    if (degraded && !parts.length && typeof body.note === 'string') parts.push(body.note);
    return parts.join(' · ').slice(0, 400);
}

/**
 * Age of a response body in seconds, or null when the body does not say.
 * One ladder for every field our routes use to stamp themselves.
 */
export function probeAgeSeconds(body, nowMs) {
    if (body == null) return null;
    const since = (iso) => {
        const t = Date.parse(iso);
        return Number.isFinite(t) ? Math.max(0, Math.floor((nowMs - t) / 1000)) : null;
    };
    if (Array.isArray(body)) {
        // NOAA JSON feeds are arrays of samples; recency = the newest timestamp.
        const last = body[body.length - 1];
        return since(last?.time_tag ?? last?.timestamp ?? last?.observed ?? '');
    }
    if (Number.isFinite(body.age_seconds)) return body.age_seconds;
    if (Number.isFinite(body.age_min)) return Math.max(0, Math.round(body.age_min * 60));
    for (const iso of [body.fetched_at, body.fetched, body.generated_at, body.updated, body.data?.updated]) {
        if (iso) { const s = since(iso); if (s != null) return s; }
    }
    return null;
}

/** Verdict for one probed /api/* route. `p` = { spec, status, body, netErr, ageSec }. */
export function endpointHealth(p) {
    const why = (degraded) => describeBody(p.body, { degraded });
    if (p.netErr)         return { level: 'crit', label: /timed? ?out|abort/i.test(p.netErr) ? 'timeout' : 'network error', detail: String(p.netErr) };
    if (p.status == null) return { level: 'crit', label: 'no response', detail: '' };
    if (p.status >= 500)  return { level: 'crit', label: `HTTP ${p.status} · ${p.body?.error ?? 'error'}`, detail: why(true) };
    if (p.status >= 400)  return { level: 'crit', label: `HTTP ${p.status}`, detail: why(true) };
    if (p.body?.error)    return { level: 'crit', label: String(p.body.error), detail: why(true) };
    // A route's OWN freshness statement beats every age heuristic below — it
    // is the one signal a degraded 200 carries. Read BEFORE freshnessExempt.
    if (p.body?.freshness === 'expired') return { level: 'crit', label: 'freshness=expired', detail: why(true) };
    if (p.body?.freshness === 'stale')   return { level: 'warn', label: 'freshness=stale', detail: why(true) };
    // Computed-at-request endpoints have no meaningful "age" — a 200 is healthy.
    if (p.ageSec == null && p.spec.freshnessExempt) return { level: 'ok', label: 'healthy', detail: why(false) };
    if (p.ageSec == null)                return { level: 'warn', label: 'no freshness info', detail: 'the body carries no timestamp this page understands' };
    if (p.ageSec > p.spec.critAgeS)      return { level: 'crit', label: 'critical (stale)', detail: `older than ${fmtSpan(p.spec.critAgeS)}` };
    if (p.ageSec > p.spec.warnAgeS)      return { level: 'warn', label: 'warning (stale)', detail: `older than ${fmtSpan(p.spec.warnAgeS)}` };
    return { level: 'ok', label: 'healthy', detail: why(false) };
}

/** Verdict for one `pipeline_heartbeat` row against its registry spec. */
export function heartbeatHealth(row, spec, nowMs) {
    if (!row) return { level: 'crit', label: 'no heartbeat row', detail: 'the pipeline has never reported — is its cron scheduled?' };
    const reason = row.last_failure_reason ? String(row.last_failure_reason) : '';
    if (!row.last_success_at) return { level: 'crit', label: 'never succeeded', detail: reason };
    const ageMin = Math.round((nowMs - new Date(row.last_success_at).getTime()) / 60_000);
    const streak = Number(row.consecutive_fail || 0);
    if (streak >= 3)            return { level: 'crit', label: 'critical', detail: `${streak} failures in a row${reason ? ` — ${reason}` : ''}` };
    if (ageMin > spec.critMin)  return { level: 'crit', label: 'critical', detail: `no success for ${fmtSpan(ageMin * 60)} (limit ${fmtSpan(spec.critMin * 60)})` };
    // Succeeding on a fallback upstream is not healthy (isFallbackSource header).
    if (isFallbackSource(spec.key, row.last_source)) {
        return { level: 'warn', label: 'degraded · fallback source', detail: `serving ${row.last_source}, not ${spec.primarySource}${reason ? ` — ${reason}` : ''}` };
    }
    if (streak >= 1)            return { level: 'warn', label: 'stale', detail: `last run failed${reason ? ` — ${reason}` : ''}` };
    if (ageMin > spec.warnMin)  return { level: 'warn', label: 'stale', detail: `no success for ${fmtSpan(ageMin * 60)} (expected within ${fmtSpan(spec.warnMin * 60)})` };
    return { level: 'ok', label: 'healthy', detail: '' };
}

/**
 * Verdict for one /api/health upstream. `u` is the edge's ping; `browser`
 * (optional) is THIS browser's own fetch of the same URL, which is the
 * authoritative check for feeds the pages fetch browser-direct (NOAA SWPC
 * 403s the Vercel edge by design, so the edge result says nothing there).
 */
export function upstreamHealth(u, browser = null) {
    const edge = u.ok ? 'edge ok' : `edge: ${u.error ?? (u.http_status != null ? `HTTP ${u.http_status}` : 'no response')}`;
    if (u.edge_authoritative) {
        return u.ok ? { level: 'ok', label: 'up', detail: '' }
                    : { level: 'crit', label: u.error ?? `HTTP ${u.http_status}`, detail: 'proxied through the edge — pages that use it are degraded' };
    }
    if (!browser) return { level: 'info', label: 'browser-direct', detail: `${edge} (informational: pages fetch this feed from the browser)` };
    if (browser.ok) return { level: 'ok', label: 'up (from this browser)', detail: edge };
    return { level: 'crit', label: browser.error ?? (browser.status ? `HTTP ${browser.status}` : 'unreachable'), detail: `unreachable from this browser · ${edge}` };
}

/** Verdict for one GIBS layer probe { ok, status, netErr }. */
export function gibsHealth(p) {
    if (p.ok)             return { level: 'ok', label: 'live', detail: '' };
    if (p.status === 404) return { level: 'crit', label: 'retired/renamed (404)', detail: 'GIBS no longer serves this layer id' };
    if (p.netErr)         return { level: 'warn', label: 'network', detail: String(p.netErr) };
    if (p.status >= 500)  return { level: 'crit', label: `HTTP ${p.status}`, detail: '' };
    return { level: 'warn', label: p.status ? `HTTP ${p.status}` : 'no response', detail: '' };
}

/**
 * Roll a list of scored feeds { group, id, label, health } into the overview:
 * counts per level and the issues (crit first, then warn), each carrying its
 * reason. 'info' rows are in `total` and `info` only.
 */
export function summarize(items) {
    const counts = { ok: 0, warn: 0, crit: 0, info: 0 };
    for (const it of items) counts[it.health.level] = (counts[it.health.level] ?? 0) + 1;
    const issues = items
        .filter((it) => it.health.level === 'crit' || it.health.level === 'warn')
        .sort((a, b) => LEVEL_RANK[a.health.level] - LEVEL_RANK[b.health.level]
            || String(a.group).localeCompare(String(b.group)) || String(a.label).localeCompare(String(b.label)));
    return { ...counts, total: items.length, scored: counts.ok + counts.warn + counts.crit, issues };
}

/** "3h" / "45m" / "2d" for a span in seconds. */
export function fmtSpan(s) {
    if (!Number.isFinite(s)) return '—';
    if (s < 90)        return `${Math.round(s)}s`;
    if (s < 5400)      return `${Math.round(s / 60)}m`;
    if (s < 2 * 86400) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
}

export function fmtAgeSec(s) {
    return s == null ? '—' : `${fmtSpan(s)} ago`;
}

export function fmtRel(iso, nowMs) {
    if (!iso) return 'never';
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return 'never';
    const s = Math.max(0, (nowMs - t) / 1000);
    return s < 60 ? 'just now' : `${fmtSpan(s)} ago`;
}

/**
 * Run `fn` over `items`, at most `limit` in flight; results keep input order.
 * The page used to fire all ~80 probes at once: each probe's 8 s timeout then
 * started while it was still queued behind the browser's connection limit,
 * and a slow upstream turned its neighbours into false "network error" rows.
 */
export async function mapLimit(items, limit, fn, onDone = null) {
    const out = new Array(items.length);
    let next = 0, done = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i], i);
            onDone?.(++done, items.length);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
    return out;
}
