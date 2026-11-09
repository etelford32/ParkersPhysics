/**
 * cme-ledger-status.js — is the CME forecast ledger actually being updated?
 * PURE (no DOM, no fetch, explicit nowMs); node-gated by
 * tests/cme-ledger-status.mjs.
 *
 * WHY THIS EXISTS (2026-11-09). The calendar on cme-forecast.html had shown
 * nothing newer than mid-October for four weeks and nobody could tell
 * whether that was a quiet Sun or a dead pipeline, because three things were
 * missing at once:
 *
 *   · the daily cron (api/cron/validation-rerun.js) left NO trace of a run
 *     that locked nothing — it wrote no heartbeat, and its only daily row
 *     was skipped on quiet days;
 *   · /api/cme/skill stamped `updated` with the REQUEST time, so the page's
 *     "updated …" label and status.html were green by construction
 *     (the registry entry was `freshnessExempt` for exactly that reason);
 *   · a blank day cell meant "no arrival forecast", "the cron did not run"
 *     and "we have not got there yet" all at once.
 *
 * The answer was "quiet Sun, healthy cron" — but the page could not say so.
 * This module is the ONE copy of the rules that let it: what counts as a
 * fresh run, what each calendar day can honestly claim, and the check the
 * daily production probe (scripts/check-cme-ledger.mjs) fails on.
 *
 * The cron runs at 06:30 UT. FRESH_H is one missed run + margin; EXPIRED_H
 * is two. js/pipeline-registry.js HEARTBEAT_PIPELINES uses the same numbers
 * (pinned by the node gate).
 */

export const LEDGER_PIPELINE = 'cme_ledger';
export const LEDGER_FRESH_H = 26;
export const LEDGER_EXPIRED_H = 50;

const HOUR = 3600e3;
const DAY = 86400e3;

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (iso) => Date.parse(`${iso}T00:00:00Z`);

/** 'fresh' | 'stale' | 'expired' | 'unknown' — never guesses a missing run time. */
export function ledgerFreshness(lastRunMs, nowMs) {
    if (!Number.isFinite(lastRunMs) || !Number.isFinite(nowMs)) return { state: 'unknown', ageH: null };
    const ageH = Math.max(0, (nowMs - lastRunMs) / HOUR);
    return { state: ageH <= LEDGER_FRESH_H ? 'fresh' : ageH <= LEDGER_EXPIRED_H ? 'stale' : 'expired', ageH };
}

const IDLE_WORDS = Object.freeze({
    'no-earth-directed-cme': 'no Earth-directed CME',
    'cme-train-passed': 'last CME train has passed',
});

/**
 * The cron's run summary → the one readable line stored as the heartbeat's
 * `last_source` and printed on the page. `failed` decides success/failure.
 *
 * @param {{ catalog: number, cmeProgram: object, fluxRope: object, outlook: object }} run
 * @returns {{ failed: boolean, text: string }}
 */
export function ledgerRunLine({ catalog = 0, cmeProgram = {}, fluxRope = {}, outlook = {} } = {}) {
    const failures = [];
    if (cmeProgram.reason) failures.push(cmeProgram.reason);
    if (fluxRope.reason && fluxRope.reason !== 'no_catalog') failures.push(fluxRope.reason);
    if (failures.length) return { failed: true, text: failures.join(' | ').slice(0, 480) };

    const n = (v) => (Number.isFinite(v) ? v : 0);
    const locked = n(cmeProgram.locked) + n(fluxRope.locked) + n(fluxRope.shadow?.locked);
    const parts = [
        `${catalog} CME${catalog === 1 ? '' : 's'} screened`,
        `${n(cmeProgram.events)} Earth-relevant`,
        `${locked} new lock${locked === 1 ? '' : 's'}`,
    ];
    const resolved = n(cmeProgram.resolved) + n(cmeProgram.falseAlarms);
    if (resolved) parts.push(`${resolved} resolved`);
    if (fluxRope.idle) parts.push(`flux-rope idle (${IDLE_WORDS[fluxRope.idle] ?? fluxRope.idle})`);
    else if (fluxRope.reason === 'no_catalog') parts.push('flux-rope idle (empty catalogue)');
    const issued = outlook.issued;
    // outlook.reason beats issued.p: an outlook that was computed but could
    // not be LOCKED (table missing, insert failed) is not on the calendar.
    parts.push(issued?.p && !outlook.reason ? 'outlook issued'
        : `outlook not issued (${String(outlook.reason ?? issued?.reason ?? 'unknown').slice(0, 60)})`);
    return { failed: false, text: parts.join(' · ') };
}

/**
 * cme_outlook_issues rows → one entry per valid day: the LATEST issue for
 * that day (shortest lead), which is the row the calendar shows, plus every
 * day on which an issue was locked (the per-day evidence that the cron ran).
 *
 * @param {Array} rows  { issue_day, valid_day, lead_days, p_arrival, p_geo,
 *                        lower_bound, obs_arrival, obs_geo, resolved_at }
 */
export function outlookByDay(rows) {
    const byDay = new Map();
    const runDays = new Set();
    for (const r of Array.isArray(rows) ? rows : []) {
        if (!r?.valid_day || !r?.issue_day) continue;
        runDays.add(String(r.issue_day));
        const prev = byDay.get(r.valid_day);
        if (prev && !(String(r.issue_day) > prev.issue_day)) continue;
        byDay.set(String(r.valid_day), {
            day: String(r.valid_day),
            issue_day: String(r.issue_day),
            lead_days: Number(r.lead_days),
            p_arrival: Number.isFinite(Number(r.p_arrival)) && r.p_arrival !== null ? Number(r.p_arrival) : null,
            p_geo: Number.isFinite(Number(r.p_geo)) && r.p_geo !== null ? Number(r.p_geo) : null,
            lower_bound: r.lower_bound === true,
            resolved: r.resolved_at != null,
            obs_arrival: r.obs_arrival ?? null,
            obs_geo: r.obs_geo ?? null,
        });
    }
    return {
        days: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
        run_days: [...runDays].sort(),
    };
}

/**
 * What one calendar day can honestly say about the ledger.
 *
 *   'future'   — after today; nothing has been checked yet
 *   'pending'  — today, the 06:30 UT run has not landed (and is not late)
 *   'checked'  — a run is on record for that day
 *   'missed'   — inside the record, and no run: a real gap, drawn as one
 *   'before'   — earlier than the per-day record reaches (not a gap)
 *
 * @param {number} dayStartMs
 * @param {{ runDays: Set<string>|string[], lastRunMs?: number, nowMs: number }} ctx
 */
export function dayRunState(dayStartMs, { runDays, lastRunMs = NaN, nowMs }) {
    const set = runDays instanceof Set ? runDays : new Set(runDays ?? []);
    const today = Math.floor(nowMs / DAY) * DAY;
    if (dayStartMs > today) return 'future';
    const iso = isoDay(dayStartMs);
    if (set.has(iso) || (Number.isFinite(lastRunMs) && isoDay(lastRunMs) === iso)) return 'checked';
    if (dayStartMs === today) {
        // Due 06:30 UT; call it late only after a generous two hours.
        return nowMs - today < 8.5 * HOUR ? 'pending' : 'missed';
    }
    let first = null;
    for (const d of set) if (first === null || d < first) first = d;
    return first !== null && iso > first ? 'missed' : 'before';
}

/**
 * The daily production check (scripts/check-cme-ledger.mjs, run by
 * .github/workflows/cme-ledger-daily.yml after the 06:30 UT cron).
 * Returns every problem found — an empty list is a pass.
 *
 * A quiet Sun is NOT a problem: zero events and zero locks pass. What fails
 * is the pipeline not having run, having failed, or the route not being
 * able to say.
 */
export function checkLedgerPayload(payload, nowMs) {
    const problems = [];
    const root = payload?.data ?? payload ?? {};
    const ledger = root.ledger ?? null;
    if (!ledger) return ['payload has no `ledger` block (route predates the daily-run record, or errored)'];

    const lastRunMs = Date.parse(ledger.last_run ?? '');
    const fresh = ledgerFreshness(lastRunMs, nowMs);
    if (fresh.state === 'unknown') problems.push('ledger.last_run is missing — no run on record');
    else if (fresh.state !== 'fresh') {
        problems.push(`last ledger run was ${fresh.ageH.toFixed(1)} h ago (${ledger.last_run}); `
            + `the daily cron is due every 24 h (limit ${LEDGER_FRESH_H} h)`);
    }
    if (Number(ledger.consecutive_fail) > 0) {
        problems.push(`ledger run is failing (${ledger.consecutive_fail} in a row): ${ledger.last_failure_reason ?? 'no reason recorded'}`);
    }
    if (!Array.isArray(root.events)) problems.push('`events` is not an array');
    if (!Array.isArray(root.models)) problems.push('`models` is not an array');

    const outlook = root.outlook ?? null;
    if (!outlook || !Array.isArray(outlook.days)) {
        problems.push('payload has no `outlook.days` — the calendar cannot draw daily odds');
    } else if (fresh.state === 'fresh') {
        // A fresh run must have put today's (or at worst yesterday's, for a
        // probe that fires before 06:30 UT) issue on the calendar and cover
        // the days ahead.
        const today = isoDay(nowMs), yesterday = isoDay(nowMs - DAY);
        const newestIssue = outlook.run_days?.at?.(-1) ?? null;
        if (newestIssue !== today && newestIssue !== yesterday) {
            problems.push(`newest outlook issue is ${newestIssue ?? 'absent'} — expected ${today}`
                + (ledger.summary ? ` (run said: ${ledger.summary})` : ''));
        } else {
            const ahead = outlook.days.filter((d) => d.day > today && d.p_arrival !== null).length;
            if (ahead < 3) problems.push(`only ${ahead} future day(s) carry an outlook probability — expected ≥ 3`);
        }
    }
    if (payload?.freshness && payload.freshness !== 'fresh' && !problems.length) {
        problems.push(`route reports freshness: '${payload.freshness}'`);
    }
    return problems;
}

/** Baseline models, in the order a screened event names its ETA from. */
export const BASELINE_MODELS = Object.freeze(['enlil', 'dbm-v1', 'ballistic-v1']);
export const BASELINE_LABELS = Object.freeze({
    enlil: 'WSA-ENLIL (NASA CCMC)', 'dbm-v1': 'drag-based model', 'ballistic-v1': 'constant speed',
});

/**
 * An Earth-relevant CME the flux-rope engine did NOT forecast (it sits
 * outside its own cone: a glancing pass) but the baselines did. The
 * calendar draws it as a SCREENED event — hollow, labelled with the
 * baseline that supplied the time — never as a Parkers Physics forecast.
 * Returns null when the event has a flux-rope forecast or no baseline.
 */
export function screenedEvent(event, primaryModel = 'flux-rope-v1') {
    const fc = event?.forecasts ?? {};
    if (fc[primaryModel]) return null;
    const model = BASELINE_MODELS.find((m) => Number.isFinite(Date.parse(fc[m]?.predicted ?? '')));
    if (!model) return null;
    const etas = BASELINE_MODELS
        .map((m) => ({ model: m, ms: Date.parse(fc[m]?.predicted ?? '') }))
        .filter((e) => Number.isFinite(e.ms));
    const offAxis = Number.isFinite(event.lat_deg) && Number.isFinite(event.lon_deg)
        ? Math.hypot(event.lat_deg, event.lon_deg) : null;
    return {
        id: String(event.event_id ?? event.donki_id),
        donkiId: event.donki_id ?? null,
        launchMs: Date.parse(event.launch ?? ''),
        speedKms: Number.isFinite(Number(event.speed_kms)) && event.speed_kms !== null ? Number(event.speed_kms) : null,
        model,
        predictedMs: etas.find((e) => e.model === model).ms,
        earliestMs: Math.min(...etas.map((e) => e.ms)),
        latestMs: Math.max(...etas.map((e) => e.ms)),
        etas,
        offAxisDeg: offAxis,
        halfDeg: Number.isFinite(event.half_deg) ? event.half_deg : null,
        truth: event.truth ?? null,
    };
}

export const _internals = { isoDay, dayMs };
