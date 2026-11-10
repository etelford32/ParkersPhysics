/**
 * layer-state.js — what a map layer's CONTROLS may claim, given its data. PURE.
 *
 * The Temperature toggle shipped with one notion of state: the checkbox. With
 * our GFS archive unpublished (production's whole first day, 2026-11-09: the
 * route answered `no_run_published`) the rail therefore showed Temperature
 * ticked, Isotherms and Warmest/coldest ticked and live, an active opacity
 * slider and a colour key ON THE MAP — over a map with no temperature on it.
 * Every control worked and changed nothing, which reads as broken toggles;
 * the one honest line was a small red note under the slider.
 *
 * The rule here: A CONTROL IS LIVE ONLY WHILE IT CAN CHANGE WHAT IS DRAWN.
 *   · the checkbox itself always stays live and keeps the reader's INTENT
 *     (ticked while the archive is down ⇒ it draws the moment data arrives)
 *   · sub-toggles, the opacity slider and the on-map key follow the DATA
 *   · a ticked layer that cannot draw says so in three places — the row's
 *     badge, the rail, and a notice on the map where the key would be — and
 *     offers Retry
 * Nothing is substituted for the archive (CLIMALYTIX_PLAN.md §17.6); this
 * only stops the controls implying a field that is not there.
 *
 * Node gate: tests/climalytix-layer-state.mjs. Browser gate:
 * tests/climalytix-temp-toggles.spec.js.
 */

/** mode → what the row badge prints (null = the row's own source label). */
export const BADGES = { down: 'No data', notime: 'No frame', loading: 'Loading' };

/** The loader's note without its own "No heat map:" lead-in (the notice has one). */
const why = (note) => String(note || '').replace(/^No heat map:\s*/i, '') || 'our archive did not answer.';

/**
 * @param {object} a
 * @param {boolean} a.checked      the Temperature checkbox (the reader's intent)
 * @param {'loading'|'live'|'stale'|'down'|undefined} a.fieldState  loadField's state
 * @param {number|null|undefined} a.frameT  index of the run frame at the timeline's instant (null = the run does not cover it)
 * @param {string} [a.note]        the loader's plain-language reason
 * @returns {{ mode:'off'|'loading'|'down'|'notime'|'on', drawable:boolean, subEnabled:boolean,
 *             keyOnMap:boolean, canRetry:boolean, badge:string|null, notice:string }}
 */
export function tempControlState({ checked, fieldState, frameT, note = '' }) {
    const mode = !checked ? 'off'
        : fieldState === 'down' ? 'down'
        : fieldState === 'live' || fieldState === 'stale' ? (frameT == null ? 'notime' : 'on')
        : 'loading';
    const drawable = mode === 'on';
    return {
        mode,
        drawable,
        subEnabled: drawable,
        keyOnMap: drawable,
        canRetry: mode === 'down',
        badge: BADGES[mode] ?? null,
        notice: mode === 'down' ? `Temperature is not drawn — ${why(note)}`
            : mode === 'notime' ? 'Temperature is not drawn: the GFS run does not cover this time.'
            : '',
    };
}

/**
 * The same question for a simple archive-fed overlay (Airflow): is the row's
 * badge its source, or a statement that there is nothing to draw?
 */
export function overlayBadge({ checked, state, t }) {
    if (!checked) return null;
    if (state === 'down') return BADGES.down;
    if (state === 'loading') return BADGES.loading;
    return t == null ? BADGES.notime : null;
}
