/**
 * donki-notifications.js — PURE mapping of DONKI `notifications` rows.
 *
 * Used by api/donki/notifications.js; node-gated by
 * tests/donki-notifications.mjs (fixtures, no network).
 *
 * WHY THIS IS A MODULE: after CCMC moved DONKI on 2026-09-30 (see
 * donki-upstream.js) the route served every notification with
 * `body: "## "` — measured on a Vercel preview 2026-10-11, 26 of 26. The
 * route read `messageBody` and sliced it, so whatever the new host puts
 * there (or wherever it moved the text to) went out unexamined. The new
 * host's row shape is UNVERIFIED from the build sandbox (ccmc.gsfc.nasa.gov
 * is egress-blocked there), so the text resolves from a CANDIDATE LIST and
 * the route self-reports what it found — the noaa-regions pattern:
 *
 *   body_source    { key: count } — which upstream key supplied the text
 *   body_coverage  rows with real text / rows
 *   item_keys      the union of upstream KEY NAMES (never values)
 *
 * One production request settles it: `curl …/api/donki/notifications |
 * jq '.body_source, .body_coverage, .item_keys'`. Then record the winning
 * key first in BODY_CANDIDATES.
 *
 * A body with no letters or digits once the markdown heading markers are
 * stripped ("## ", "##\n##") is NOT text: it is null, and when no row has
 * text the response carries a `note` saying so — never ship "## " again.
 *
 * DONKI's text is the SWRC message template: a "## "-prefixed header block
 * (centre name, message type, issue date, id, disclaimer) and then a
 * "## Summary:" section. The header repeats what `type` / `issue_time` /
 * `id` already carry, and a 120-char excerpt of it (sun-watch's ledger
 * detail) was always "NASA Goddard Space Flight Center, …". So when a
 * Summary section exists the body STARTS there; otherwise it is the whole
 * message with the heading markers removed.
 */

/** Upstream keys that may hold the message text, in preference order.
 *  `messageBody` is the pre-2026-09-30 key. */
export const BODY_CANDIDATES = Object.freeze([
    'messageBody', 'message_body', 'messageText', 'message_text',
    'body', 'message', 'text', 'content', 'messageSummary', 'summary',
]);

export const BODY_MAX_CHARS = 400;

const HAS_TEXT = /[\p{L}\p{N}]/u;

function asText(v) {
    if (typeof v === 'string') return v;
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join('\n');
    return null;
}

/**
 * Turn one raw message into display text, or null when it carries none.
 * Strips HTML tags (defensive — a web-page port may serve markup), the
 * markdown heading markers, blank lines, and the template header when a
 * Summary section follows it.
 */
export function normalizeBody(raw) {
    const s = asText(raw);
    if (s == null) return null;
    let text = s.replace(/\r\n?/g, '\n');
    if (/<\/?(p|br|div|span|h\d|pre|a)\b/i.test(text)) {
        text = text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h\d)>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    }
    let lines = text.split('\n').map((l) => l.replace(/^\s*#+[ \t]?/, '').replace(/\s+$/, ''));
    const at = lines.findIndex((l) => /^\s*\**summary\**\s*:?/i.test(l));
    if (at >= 0) {
        const rest = lines[at].replace(/^\s*\**summary\**\s*:?\s*/i, '');
        const tail = [rest, ...lines.slice(at + 1)];
        if (tail.some((l) => HAS_TEXT.test(l))) lines = tail;
    }
    const out = lines.filter((l) => l.trim()).join('\n').trim();
    return HAS_TEXT.test(out) ? out : null;
}

/** First candidate key with real text. @returns {{ text: string|null, key: string|null }} */
export function extractBody(n) {
    for (const key of BODY_CANDIDATES) {
        if (n == null || !(key in n)) continue;
        const text = normalizeBody(n[key]);
        if (text) return { text, key };
    }
    return { text: null, key: null };
}

/**
 * Map raw DONKI rows to the route's notification objects + the
 * self-report. `isoTag` is injected so this module stays dependency-free.
 */
export function mapNotifications(raw, { isoTag = (s) => s } = {}) {
    const rows = (Array.isArray(raw) ? raw : []).filter((n) => n?.messageIssueTime);
    const bodySource = {};
    const keys = new Set();
    let withText = 0;

    const notes = rows.map((n) => {
        for (const k of Object.keys(n)) keys.add(k);
        const { text, key } = extractBody(n);
        if (key) { bodySource[key] = (bodySource[key] ?? 0) + 1; withText++; }
        return {
            type:       n.messageType ?? null,
            issue_time: isoTag(n.messageIssueTime),
            id:         n.messageID   ?? null,
            url:        n.messageURL  ?? null,
            body:       text ? text.slice(0, BODY_MAX_CHARS) : null,
        };
    }).sort((a, b) => (b.issue_time ?? '').localeCompare(a.issue_time ?? ''));

    const report = {
        body_source:   bodySource,
        body_coverage: `${withText}/${rows.length}`,
        item_keys:     [...keys].sort(),
    };
    if (rows.length > 0 && withText === 0) {
        report.note = 'Upstream DONKI notifications carried no message text in any known field '
            + `(${BODY_CANDIDATES.join(', ')}); body is null — the full message is at each notification's url.`;
    }
    return { notes, report };
}
