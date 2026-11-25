/**
 * climalytix/places-pitch.js — WHAT THE PAGE SAYS about remembering places,
 * and when it asks for a sign-up. PURE: state in, one message out.
 * ═══════════════════════════════════════════════════════════════════════════
 * The location search is Climalytix's sign-up mechanism, and this is its one
 * rule book. The page renders exactly what `pitch()` returns — it holds no
 * copy and no thresholds of its own — so every claim below is node-gated
 * (tests/climalytix-pitch.mjs).
 *
 * THE LADDER (signed out):
 *   invite     nothing collected yet — one quiet line saying what an account does
 *   session    1–2 places — the same line, now with what is at stake
 *   ownership  3+ places — a CARD: the reader has built something, name it,
 *              say it ends with the tab, offer the account. This is the ask.
 * and after the ask:
 *   pending    email submitted, magic link not clicked yet
 *   welcome    first signed-in load that ADOPTED places collected before
 *   account    signed in, a sync has landed
 *   device     signed in, no sync has landed (never claims the account)
 *
 * RULES, each a decision:
 *   · THE CARD IS EARNED, NEVER IMMEDIATE. Asking a first-time visitor to sign
 *     up before they have used anything is the pattern that taught people to
 *     close banners. Below PITCH_STEPS[0] distinct places it is one line.
 *   · "NOT NOW" IS RESPECTED UNTIL THERE IS MORE TO LOSE. A dismissal holds
 *     until the collection reaches the NEXT step (3 → 6 → 10), then the card
 *     may appear once more. Past the last step it never re-arms.
 *   · IT NEVER LIES ABOUT WHERE THINGS ARE KEPT. `kept` comes from
 *     places-store `placesStatus` and "in your account" is said only for
 *     kept === 'account'.
 *   · NUMBERS AND NAMES ARE THE READER'S OWN — the card lists their places,
 *     never a generic benefit list.
 */

export const PITCH_STEPS = Object.freeze([3, 6, 10]);

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Tokyo", "Tokyo and Paris", "Tokyo, Paris and Lima", "Tokyo, Paris and 3 more". */
export function listNames(names, max = 3) {
    const list = (Array.isArray(names) ? names : []).map((s) => String(s ?? '').trim()).filter(Boolean);
    if (!list.length) return '';
    if (list.length === 1) return list[0];
    if (list.length <= max) return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
    const shown = list.slice(0, max - 1);
    return `${shown.join(', ')} and ${list.length - shown.length} more`;
}

/** The highest step the collection has reached (0 below the first). */
export function stepReached(count, steps = PITCH_STEPS) {
    let s = 0;
    for (const v of steps) if (count >= v) s = v;
    return s;
}

/** Is the ownership card showing? `dismissedAt` is the step that was dismissed (0 = never). */
export function cardArmed(count, dismissedAt = 0, steps = PITCH_STEPS) {
    return stepReached(count, steps) > (Number(dismissedAt) || 0);
}

/**
 * @param {object} s
 * @param {'session'|'pending'|'account'} s.scope
 * @param {'session'|'device'|'account'} s.kept
 * @param {string|null} [s.syncState]
 * @param {string[]} [s.saved]   saved place names, in order
 * @param {string[]} [s.recent]  history names, newest first
 * @param {number} [s.adopted]   places adopted into the account on THIS load
 * @param {string|null} [s.resumed]  a place saved on this load because the reader asked before signing in
 * @param {number} [s.dismissedAt]   step of the last "Not now"
 * @param {boolean} [s.welcomeSeen]
 * @returns {{stage, kind:'line'|'card'|'none', tone:'ask'|'info'|'good'|'warn', count, names:string[],
 *            headline?:string, body:string, cta?:{label:string, action:'signup'}, signin?:boolean,
 *            dismiss?:{label:string, step:number}}}
 */
export function pitch(s = {}) {
    const saved = Array.isArray(s.saved) ? s.saved : [];
    const recent = Array.isArray(s.recent) ? s.recent : [];
    const names = [...saved, ...recent.filter((n) => !saved.includes(n))];
    const count = names.length;
    const base = { count, names };

    if (s.scope === 'account') {
        const adopted = Math.max(0, Math.floor(Number(s.adopted) || 0));
        const down = s.syncState === 'error' || s.syncState === 'migration-pending' || String(s.syncState || '').startsWith('off');
        if ((adopted || s.resumed) && !s.welcomeSeen) {
            const where = s.kept === 'account' ? 'now in your account'
                : down ? 'kept on this device — account sync is unavailable right now'
                : 'on this device and syncing to your account';
            const bits = [];
            if (adopted) bits.push(`${plural(adopted, 'place')} from before you signed in ${adopted === 1 ? 'is' : 'are'} ${where}`);
            if (s.resumed) bits.push(`${s.resumed} is saved, as you asked`);
            return { ...base, stage: 'welcome', kind: 'card', label: 'Your places', tone: s.kept === 'account' ? 'good' : down ? 'warn' : 'info',
                headline: 'You’re signed in — your places came with you.',
                body: `${bits.join('; ')}. Search anywhere and it is remembered from here on.`,
                dismiss: { label: 'Got it', step: 0 } };
        }
        if (s.kept === 'account') {
            return { ...base, stage: 'account', kind: count ? 'line' : 'none', tone: 'good',
                body: 'Saved places and history are kept in your account.' };
        }
        return { ...base, stage: 'device', kind: count ? 'line' : 'none', tone: down ? 'warn' : 'info',
            body: down ? 'Saved places and history are kept on this device — account sync is unavailable right now.'
                : 'Saved places and history are kept on this device; syncing to your account…' };
    }

    if (s.scope === 'pending') {
        return { ...base, stage: 'pending', kind: 'line', tone: 'info',
            body: `Check your inbox to finish signing up — ${count ? `your ${plural(count, 'place')} ${count === 1 ? 'is' : 'are'}` : 'your places are'} kept on this device and move into your account when you sign in.` };
    }

    // signed out
    if (!count) {
        return { ...base, stage: 'invite', kind: 'line', tone: 'ask', signin: true,
            body: 'Climalytix can remember every place you analyse.',
            cta: { label: 'Sign up free', action: 'signup' } };
    }
    if (cardArmed(count, s.dismissedAt)) {
        return { ...base, stage: 'ownership', kind: 'card', label: 'Keep your places', tone: 'ask', signin: true,
            headline: `Keep your ${plural(count, 'place')}?`,
            body: `${listNames(names)} ${count === 1 ? 'is' : 'are'} only kept until this tab closes. A free account saves ${count === 1 ? 'it' : 'them'} — and your search history — on every device.`,
            cta: { label: `Keep my ${count === 1 ? 'place' : 'places'} — free`, action: 'signup' },
            dismiss: { label: 'Not now', step: stepReached(count) } };
    }
    return { ...base, stage: 'session', kind: 'line', tone: 'ask', signin: true,
        body: `${plural(count, 'place')} kept for this session only — gone when this tab closes.`,
        cta: { label: 'Sign up free to keep ' + (count === 1 ? 'it' : 'them'), action: 'signup' } };
}

/** The sentence the sign-up dialog adds under its own copy: what, exactly, will be kept. */
export function gateNote(names, { saving = null } = {}) {
    const list = (Array.isArray(names) ? names : []).filter(Boolean);
    const all = saving && !list.includes(saving) ? [saving, ...list] : list;
    if (!all.length) return '';
    return `${listNames(all)} will be waiting in your account.`;
}
