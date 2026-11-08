/**
 * recent-development.js — renders recent-development.html from js/dev-log.js
 * ═══════════════════════════════════════════════════════════════════════════
 * The page computes nothing about WHAT shipped — that is all js/dev-log.js.
 * This module only lays it out: a "just shipped" spotlight, a filter bar
 * (search · kind · section), and the timeline grouped by sprint.
 *
 * Filter state lives in the URL (?kind=&section=&q=) so a filtered view is
 * shareable, and every entry has an anchor (#<id>) that scrolls to and
 * flashes it. The markup builders are exported so feedback.html can render
 * the same compact rows without a second copy.
 */

import {
    DEV_LOG, KINDS, LOG_SECTIONS, SPRINTS,
    groupBySprint, countByKind, latest, isFresh, matches,
    linkLabel, formatDate, sprintRange, sprintFor, prUrl,
} from './dev-log.js';
import { glyph } from './glyphs.js';

const esc = s => String(s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const KIND_BY_ID = Object.fromEntries(KINDS.map(k => [k.id, k]));
const SECTION_BY_ID = Object.fromEntries(LOG_SECTIONS.map(s => [s.id, s]));

function kindBadge(kind) {
    const k = KIND_BY_ID[kind];
    return `<span class="rd-kind rd-kind-${esc(kind)}">${esc(k ? k.short : kind)}</span>`;
}

function sectionTag(section) {
    const s = SECTION_BY_ID[section];
    return `<span class="rd-section">${esc(s ? s.label : section)}</span>`;
}

function linkButtons(entry, { compact = false } = {}) {
    const links = entry.links.map((link, i) => {
        const label = linkLabel(link) || link.href;
        const cls = i === 0 && !compact ? 'rd-open rd-open-primary' : 'rd-open';
        return `<a class="${cls}" href="${esc(link.href)}">${compact ? '' : 'Open '}${esc(label)} <span aria-hidden="true">&rarr;</span></a>`;
    });
    if (entry.pr && !compact) {
        links.push(`<a class="rd-pr" href="${esc(prUrl(entry.pr))}" target="_blank" rel="noopener" `
            + `title="The pull request that shipped this">PR #${entry.pr}</a>`);
    }
    return links.join('');
}

/** One timeline entry. */
export function entryHtml(entry, { nowMs = Date.now() } = {}) {
    const fresh = isFresh(entry, nowMs) ? '<span class="sim-badge sim-badge-new">NEW</span>' : '';
    const highlights = entry.highlights && entry.highlights.length
        ? `<details class="rd-details"><summary>What changed <span class="rd-dim">(${entry.highlights.length})</span></summary>`
          + `<ul>${entry.highlights.map(h => `<li>${esc(h)}</li>`).join('')}</ul></details>`
        : '';
    return `<article class="rd-entry" id="${esc(entry.id)}" data-kind="${esc(entry.kind)}" data-section="${esc(entry.section)}">
  <div class="rd-entry-date"><time datetime="${esc(entry.date)}">${esc(formatDate(entry.date, { year: false }))}</time></div>
  <div class="rd-entry-icon" aria-hidden="true">${glyph(entry.icon, { size: 22 })}</div>
  <div class="rd-entry-body">
    <div class="rd-entry-meta">${kindBadge(entry.kind)}${sectionTag(entry.section)}${fresh}</div>
    <h3 class="rd-entry-title"><a href="#${esc(entry.id)}" class="rd-anchor" title="Link to this update">${esc(entry.title)}</a></h3>
    <p class="rd-entry-summary">${esc(entry.summary)}</p>
    ${highlights}
    <div class="rd-links">${linkButtons(entry)}</div>
  </div>
</article>`;
}

/** Compact row (feedback.html's panel). */
export function compactEntryHtml(entry) {
    return `<div class="rd-compact">
  <div class="rd-compact-head"><time datetime="${esc(entry.date)}">${esc(formatDate(entry.date))}</time>${kindBadge(entry.kind)}</div>
  <a class="rd-compact-title" href="recent-development.html#${esc(entry.id)}">${esc(entry.title)}</a>
  <p>${esc(entry.summary)}</p>
</div>`;
}

function spotlightHtml(entry, nowMs) {
    const first = entry.links[0];
    const sprint = sprintFor(entry.date);
    return `<article class="rd-spot">
  <div class="rd-spot-top">
    <span class="rd-spot-icon" aria-hidden="true">${glyph(entry.icon, { size: 26 })}</span>
    <span class="rd-spot-meta">${kindBadge(entry.kind)}${isFresh(entry, nowMs) ? '<span class="sim-badge sim-badge-new">NEW</span>' : ''}</span>
  </div>
  <time class="rd-spot-date" datetime="${esc(entry.date)}">${esc(formatDate(entry.date))}${sprint ? ` · ${esc(sprint.label)}` : ''}</time>
  <h3 class="rd-spot-title"><a href="#${esc(entry.id)}">${esc(entry.title)}</a></h3>
  <p class="rd-spot-summary">${esc(entry.summary)}</p>
  <a class="rd-open rd-open-primary" href="${esc(first.href)}">Open ${esc(linkLabel(first) || first.href)} <span aria-hidden="true">&rarr;</span></a>
</article>`;
}

function sprintHeadHtml(sprint, entries) {
    const counts = countByKind(entries);
    const chips = KINDS.filter(k => counts[k.id] > 0)
        .map(k => `<span class="rd-count">${kindBadge(k.id)}<b>${counts[k.id]}</b></span>`).join('');
    const open = sprint.end == null ? '<span class="rd-live">In progress</span>' : '';
    return `<header class="rd-sprint-head">
  <p class="rd-sprint-range">${esc(sprintRange(sprint))}${open}</p>
  <h2 class="rd-sprint-title" id="sprint-${esc(sprint.id)}">${esc(sprint.label)}</h2>
  <p class="rd-sprint-goal">${esc(sprint.goal)}</p>
  <div class="rd-sprint-counts">${chips}</div>
</header>`;
}

// ── Page wiring ─────────────────────────────────────────────────────────────

function readState() {
    const p = new URLSearchParams(location.search);
    const kind = KIND_BY_ID[p.get('kind')] ? p.get('kind') : '';
    const section = SECTION_BY_ID[p.get('section')] ? p.get('section') : '';
    return { kind, section, q: (p.get('q') || '').slice(0, 120) };
}

function writeState(state) {
    const p = new URLSearchParams();
    if (state.kind) p.set('kind', state.kind);
    if (state.section) p.set('section', state.section);
    if (state.q.trim()) p.set('q', state.q.trim());
    const qs = p.toString();
    history.replaceState(null, '', `${location.pathname}${qs ? '?' + qs : ''}${location.hash}`);
}

function chipRow(host, items, active, attr) {
    host.innerHTML = items.map(({ id, label, count }) => {
        const on = id === active;
        return `<button type="button" class="sim-chip${on ? ' is-on' : ''}" data-${attr}="${esc(id)}" aria-pressed="${on}">`
            + `${esc(label)}${count != null ? ` <span class="rd-chip-n">${count}</span>` : ''}</button>`;
    }).join('');
}

export function mountRecentDevelopment(root = document, { nowMs = Date.now() } = {}) {
    const $ = id => root.getElementById(id);
    const state = readState();

    // Hero numbers
    const newest = latest(1)[0];
    const openSprint = SPRINTS.find(s => s.end == null);
    $('rd-stats').innerHTML = [
        `<span><b>${DEV_LOG.length}</b> updates logged</span>`,
        `<span><b>${SPRINTS.length}</b> sprints</span>`,
        newest ? `<span>Last update <b>${esc(formatDate(newest.date))}</b></span>` : '',
        openSprint ? `<span>Now: <a href="#sprint-${esc(openSprint.id)}">${esc(openSprint.label)}</a></span>` : '',
    ].filter(Boolean).join('<span class="rd-sep" aria-hidden="true">·</span>');

    // Spotlight — newest simulations / layers first, then anything.
    const showcase = DEV_LOG.filter(e => e.kind === 'simulation' || e.kind === 'layer');
    $('rd-spotlight').innerHTML = latest(3, showcase.length >= 3 ? showcase : DEV_LOG)
        .map(e => spotlightHtml(e, nowMs)).join('');

    const search = $('rd-search');
    search.value = state.q;

    function renderChips() {
        const base = { section: state.section, q: state.q };
        const kindCounts = countByKind(DEV_LOG.filter(e => matches(e, base)));
        const allKinds = DEV_LOG.filter(e => matches(e, base)).length;
        chipRow($('rd-kind-chips'),
            [{ id: '', label: 'All kinds', count: allKinds },
             ...KINDS.map(k => ({ id: k.id, label: k.short, count: kindCounts[k.id] }))],
            state.kind, 'kind');
        const secBase = { kind: state.kind, q: state.q };
        chipRow($('rd-section-chips'),
            [{ id: '', label: 'All sections' },
             ...LOG_SECTIONS.map(s => ({ id: s.id, label: s.label,
                 count: DEV_LOG.filter(e => e.section === s.id && matches(e, secBase)).length }))]
                .filter(c => c.id === '' || c.count > 0 || c.id === state.section),
            state.section, 'section');
    }

    function render() {
        renderChips();
        const groups = groupBySprint(DEV_LOG, state);
        const shown = groups.reduce((n, g) => n + g.entries.length, 0);
        const filtered = state.kind || state.section || state.q.trim();
        $('rd-result').textContent = filtered
            ? `Showing ${shown} of ${DEV_LOG.length} updates`
            : `All ${DEV_LOG.length} updates, newest first`;
        $('rd-empty').hidden = shown > 0;
        $('rd-timeline').innerHTML = groups.map(({ sprint, entries }) =>
            `<section class="rd-sprint" aria-labelledby="sprint-${esc(sprint.id)}">${sprintHeadHtml(sprint, entries)}`
            + `<div class="rd-entries">${entries.map(e => entryHtml(e, { nowMs })).join('')}</div></section>`).join('');
        writeState(state);
    }

    $('rd-kind-chips').addEventListener('click', ev => {
        const b = ev.target.closest('[data-kind]');
        if (!b) return;
        state.kind = b.dataset.kind === state.kind ? '' : b.dataset.kind;
        render();
    });
    $('rd-section-chips').addEventListener('click', ev => {
        const b = ev.target.closest('[data-section]');
        if (!b) return;
        state.section = b.dataset.section === state.section ? '' : b.dataset.section;
        render();
    });
    let t = 0;
    search.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => { state.q = search.value; render(); }, 120);
    });
    $('rd-clear').addEventListener('click', () => {
        state.kind = ''; state.section = ''; state.q = ''; search.value = '';
        render();
    });

    render();

    // Deep link: make sure the target is visible (clear filters that hide it),
    // then scroll to it and flash it.
    function focusHash() {
        const id = decodeURIComponent(location.hash.slice(1));
        if (!id || id.startsWith('sprint-')) return;
        const entry = DEV_LOG.find(e => e.id === id);
        if (!entry) return;
        if (!matches(entry, state)) {
            state.kind = ''; state.section = ''; state.q = ''; search.value = '';
            render();
        }
        const el = root.getElementById(id);
        if (!el) return;
        el.scrollIntoView({ block: 'center' });
        el.classList.remove('rd-flash');
        void el.offsetWidth;
        el.classList.add('rd-flash');
        const det = el.querySelector('details');
        if (det) det.open = true;
    }
    window.addEventListener('hashchange', focusHash);
    focusHash();

    window.__recentDev = { state, render };
}
