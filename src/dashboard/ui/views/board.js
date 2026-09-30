import { h, icon } from '../dom.js';
import { duration, metaText, plural } from '../format.js';

/**
 * The Board (spec section 13 Board; docs/design/mockups/board.html): a sidebar whose entries filter
 * the board (epics, agents, labels), the needs-you strip, a toolbar, then five columns of cards, or
 * one swimlane of five columns per epic or agent.
 *
 * Filters live in the hash only: #/board?epic=&agent=&label=&group=&q=&done=all. They combine:
 * - epic: an epic's id; a card matches when that epic is one of its ancestors (card.epicIds);
 * - agent: the holder's agent id (card.assignee), or "none" for stalled cards;
 * - label: one of the card's labels;
 * - q: the ids /api/search returns for it, asked once per q and board seq, so a task created or
 *   changed since shows as it should;
 * - group: "epic" or "agent" for swimlanes; done: "all" to show every Done card, not only the
 *   last 7 days (measured from the view's `now`). The swimlanes hold the cards shown, so an epic
 *   whose tasks are all older Done tasks has no lane.
 * A filter that matches nothing, such as an epic since deleted, shows "No tasks match these filters."
 *
 * The app builds the view again on every load and every 30 s, so it keeps no state in the DOM: the
 * opened "+ N more" lists and the search live in this module, focusable elements have stable
 * data-keys, the sidebar's scroller a data-scroll-key, and relative times use the context's `now`.
 *
 * @typedef {import('../app.js').ViewContext} ViewContext
 * @typedef {{ epic: string, agent: string, label: string, q: string, group: '' | 'epic' | 'agent', all: boolean }} Filters
 * @typedef {{ key: string, name: string, cards: any[], marker: Node | null, sub: boolean }} Lane
 */

/** The columns, in board order: [key, name]. */
const COLUMNS = [['backlog', 'Backlog'], ['ready', 'Ready'], ['in_progress', 'In progress'], ['blocked', 'Blocked'], ['done', 'Done']];
/** Backlog and Ready show this many cards, then "+ N more". */
const LIMIT = 20;
const LIMITED = new Set(['backlog', 'ready']);
/** Done shows the tasks done in this last span of time, unless done=all. */
const DONE_WINDOW = 7 * 24 * 3_600_000;
/** The hash parameters of the board, in the order the hash lists them. */
const PARAMS = ['epic', 'agent', 'label', 'group', 'q', 'done'];
/** The parameters "Clear filters" removes; group and done only change how the board shows. */
const FILTERS = ['epic', 'agent', 'label', 'q'];

/** A search that failed is asked again by the first render this long after (a load, or the 30 s tick). */
const SEARCH_RETRY_MS = 10_000;

/** The "+ N more" lists opened, as `${lane key}:${column key}`. */
const expanded = new Set();

/**
 * The search for the current q at the board's seq: the ids and total /api/search answered (the last
 * answer for this q until the one for this seq comes), null before any; failedAt: when the last ask
 * failed (this browser's clock), else null. A new q or seq asks again; an older ask's answer is dropped.
 * @type {{ q: string, seq: number, ids: Set<number> | null, total: number, failedAt: number | null }}
 */
let search = { q: '', seq: -1, ids: null, total: 0, failedAt: null };

/** A share in whole percents, 0 when there is nothing. @param {number} part @param {number} whole */
const percent = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/** Board text (titles, epic names, labels) in its own direction. @param {string} text @param {string} [cls] */
const bidi = (text, cls) => h('span', { class: ['bidi', cls], dir: 'auto' }, text);

/** A thin progress bar filled to `pct`. @param {number} pct */
function bar(pct) {
  const fill = h('span', { class: 'bar-fill' });
  fill.style.setProperty('--pct', `${pct}%`);
  return h('span', { class: 'bar bar-side', 'aria-hidden': 'true' }, fill);
}

/**
 * An agent's avatar: the initial on the agent's color; the dashed "?" when `who` is null (no agent).
 * @param {{ name: string, color: string, initial?: string } | null} who
 */
function avatar(who) {
  if (!who) return h('span', { class: 'avatar avatar-sm avatar-none', 'aria-hidden': 'true' }, '?');
  const el = h('span', { class: 'avatar avatar-sm', 'aria-hidden': 'true' }, who.initial ?? (Array.from(who.name)[0] ?? '?').toUpperCase());
  el.style.setProperty('--agent-color', who.color);
  return el;
}

// ------------------------------------------------------------------------------------------------
// Filters and the hash
// ------------------------------------------------------------------------------------------------

/** @param {Record<string, string>} p the route's params @returns {Filters} */
function filtersOf(p) {
  return {
    epic: p.epic ?? '',
    agent: p.agent ?? '',
    label: p.label ?? '',
    q: (p.q ?? '').trim(),
    group: p.group === 'epic' || p.group === 'agent' ? p.group : '',
    all: p.done === 'all',
  };
}

/**
 * The board's hash with `change` applied to `params`; empty values are left out.
 * @param {Record<string, string>} params @param {Record<string, string>} [change] @returns {string}
 */
function boardHref(params, change = {}) {
  const next = { ...params, ...change };
  const query = new URLSearchParams();
  for (const key of PARAMS) if (next[key]) query.set(key, next[key]);
  const s = query.toString();
  return s ? `#/board?${s}` : '#/board';
}

/** Does the card pass the filters? @param {Filters} f @param {Set<number> | null} ids the search's, null without q */
function matcher(f, ids) {
  const epic = Number(f.epic);
  return (/** @type {any} */ c) => (!f.epic || c.epicIds.includes(epic))
    && (!f.agent || (f.agent === 'none' ? c.stalled != null : c.assignee?.id === f.agent))
    && (!f.label || c.labels.includes(f.label))
    && (!ids || ids.has(c.id));
}

/**
 * The search for `q` at the board's `seq`, asked once: another q or seq (or an ask that failed a
 * while ago) asks /api/search and renders the view again when the answer comes.
 * @param {string} q @param {number} seq @param {() => void} rerender
 */
function searchFor(q, seq, rerender) {
  const retry = search.failedAt != null && Date.now() - search.failedAt >= SEARCH_RETRY_MS;
  if (search.q === q && search.seq === seq && !retry) return search;
  const kept = search.q === q ? search : null; // what shows until the new answer comes
  const mine = { q, seq, ids: kept?.ids ?? null, total: kept?.total ?? 0, failedAt: /** @type {number | null} */ (null) };
  search = mine;
  fetch(`/api/search?${new URLSearchParams({ q })}`, { cache: 'no-store', headers: { Accept: 'application/json' } })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((body) => {
      const ids = Array.isArray(body?.ids) ? body.ids : [];
      mine.ids = new Set(ids);
      mine.total = Number.isFinite(body?.total) ? body.total : ids.length;
    })
    .catch(() => {
      mine.failedAt = Date.now();
    })
    .finally(() => {
      if (search === mine) rerender();
    });
  return mine;
}

// ------------------------------------------------------------------------------------------------
// Sidebar
// ------------------------------------------------------------------------------------------------

/**
 * The sidebar: every entry sets its filter; the selected one is highlighted, and turns it off.
 * @param {any} view @param {Filters} f @param {Record<string, string>} params
 */
function sidebar(view, f, params) {
  const cards = view.cards ?? [];
  /** The hash that sets `key` to `value`, or removes it when it is the current one. */
  const toggle = (/** @type {'epic' | 'agent' | 'label'} */ key, /** @type {string} */ value) => boardHref(params, { [key]: f[key] === value ? '' : value });
  const current = (/** @type {boolean} */ on) => (on ? 'true' : null);
  const group = (/** @type {string} */ id, /** @type {string} */ title, /** @type {unknown[]} */ ...children) => h('div', { class: 'side-group', role: 'group', 'aria-labelledby': id },
    h('h2', { class: 'side-title', id }, title), children);

  const epics = group('side-epics', 'Epics',
    h('a', { class: 'side-item side-all', href: boardHref(params, { epic: '' }), 'aria-current': current(!f.epic), 'data-testid': 'side-epic-all', 'data-key': 'side-epic-all' },
      h('span', null, 'All tasks'), h('span', { class: 'side-count' }, cards.length)),
    (view.epics ?? []).map((e) => h('a', {
      class: ['side-item', 'side-epic', e.depth === 1 && 'is-sub'], href: toggle('epic', String(e.id)), 'aria-current': current(f.epic === String(e.id)),
      'data-testid': 'side-epic', 'data-key': `side-epic-${e.id}`,
    },
      h('span', { class: 'side-line' }, h('span', { class: 'bidi side-name', dir: 'auto', title: e.title }, e.title), h('span', { class: 'side-count' }, `${e.done}/${e.total}`)),
      bar(percent(e.done, e.total)))));

  const agents = group('side-agents', 'Agents',
    (view.agents ?? []).map((a) => h('a', {
      class: 'side-item side-agent', href: toggle('agent', a.id), 'aria-current': current(f.agent === a.id), 'data-testid': 'side-agent', 'data-key': `side-agent-${a.id}`,
    },
      avatar(a), h('span', { class: 'side-name' }, a.name), a.task && h('span', { class: 'side-task' }, `#${a.task.id}`))),
    h('a', {
      class: 'side-item side-agent', href: toggle('agent', 'none'), 'aria-current': current(f.agent === 'none'), 'data-testid': 'side-agent', 'data-key': 'side-agent-none',
      title: 'Claimed tasks whose agent session has ended',
    },
      avatar(null), h('span', { class: 'side-name' }, 'No agent'), h('span', { class: 'side-count' }, cards.filter((c) => c.stalled).length)));

  const labels = view.labels ?? [];
  const labelGroup = group('side-labels', 'Labels',
    labels.length === 0
      ? h('p', { class: 'side-empty' }, 'No labels yet.')
      : h('div', { class: 'side-labels' }, labels.map((l) => h('a', {
        class: 'side-label', href: toggle('label', l.name), 'aria-current': current(f.label === l.name), 'data-testid': 'side-label', 'data-key': `side-label-${l.name}`,
      }, bidi(l.name), ` · ${l.count}`))));

  return h('aside', { class: 'board-side', 'data-testid': 'board-sidebar', 'aria-label': 'Board filters' },
    h('div', { class: 'board-side-inner', 'data-scroll-key': 'board-side' }, epics, agents, labelGroup));
}

// ------------------------------------------------------------------------------------------------
// Needs-you strip, toolbar
// ------------------------------------------------------------------------------------------------

/** Hidden (null) when nothing needs the human. @param {any} needs view.needsYou @param {number} now */
function needsStrip(needs, now) {
  if (!needs || !(needs.count > 0)) return null;
  const chip = (/** @type {string} */ text, /** @type {string} */ href, /** @type {string} */ key) => h('a', { class: 'strip-chip', href, 'data-testid': 'strip-chip', 'data-key': key }, text);
  return h('section', { class: 'strip', 'data-testid': 'needs-strip', 'aria-label': 'Needs you' },
    h('span', { class: 'strip-title' }, needs.count === 1 ? '1 thing needs you' : `${needs.count} things need you`),
    (needs.questions ?? []).map((q) => chip(`#${q.taskId} question from ${q.askedBy}`, `#/task/${q.taskId}`, `strip-q-${q.questionId}`)),
    needs.approvals && chip(`${plural(needs.approvals.items.length, 'suggestion')} to approve`, '#/', 'strip-approve'),
    (needs.stalled ?? []).map((s) => chip(
      Number.isFinite(s.since) ? `#${s.id} no agent for ${duration(now - s.since)}` : `#${s.id} no agent`, `#/task/${s.id}`, `strip-stalled-${s.id}`,
    )),
    h('a', { class: 'strip-see', href: '#/', 'data-key': 'strip-see' }, 'See what to ask'));
}

/**
 * A toolbar dropdown: a native <select> laid over a button that reads "Label: value". The current
 * value gets an option of its own when it is not among `options` (an epic since deleted).
 * @param {'epic' | 'agent' | 'label' | 'group'} name the hash parameter
 * @param {string} label @param {string} value the current value ('' for all)
 * @param {[string, string][]} options [value, text], the first one for ''
 * @param {string} shown the button's text for the current value
 * @param {Record<string, string>} params
 */
function dropdown(name, label, value, options, shown, params) {
  const list = options.some(([v]) => v === value) ? options : [...options, /** @type {[string, string]} */ ([value, shown])];
  const select = h('select', {
    'aria-label': label, 'data-key': `filter-${name}`,
    onchange: () => { location.hash = boardHref(params, { [name]: select.value }); },
  }, list.map(([v, text]) => h('option', { value: v }, text)));
  /** @type {HTMLSelectElement} */ (select).value = value;
  return h('div', { class: ['filter', value && 'is-set'], 'data-testid': `filter-${name}` },
    h('span', { class: 'filter-text', 'data-testid': 'filter-text', 'aria-hidden': 'true' }, `${label}: ${shown}`),
    icon('chevron-down', 14),
    select);
}

/** @param {any} view @param {Filters} f @param {Record<string, string>} params */
function toolbar(view, f, params) {
  const epics = view.epics ?? [];
  const agents = view.agents ?? [];
  const labels = view.labels ?? [];
  const epic = epics.find((e) => String(e.id) === f.epic);
  const parentOf = (e) => epics.find((p) => p.id === e.parent);
  const agent = agents.find((a) => a.id === f.agent);
  // an agent gone from the list (its session ended) keeps its name on the cards it holds
  const holder = agent ?? (view.cards ?? []).find((c) => c.assignee?.id === f.agent)?.assignee;

  return h('div', { class: 'toolbar', 'data-testid': 'board-toolbar' },
    h('h1', { class: 'page-title toolbar-title' }, 'Board'),
    dropdown('epic', 'Epic', f.epic,
      [['', 'All'], ...epics.map((e) => /** @type {[string, string]} */ ([String(e.id), e.depth === 1 && parentOf(e) ? `${parentOf(e).title} › ${e.title}` : e.title]))],
      !f.epic ? 'all' : epic ? epic.title : `#${f.epic}`, params),
    dropdown('agent', 'Agent', f.agent,
      [['', 'All'], ...agents.map((a) => /** @type {[string, string]} */ ([a.id, a.name])), ['none', 'No agent']],
      !f.agent ? 'all' : f.agent === 'none' ? 'No agent' : holder ? holder.name : 'unknown', params),
    dropdown('label', 'Label', f.label,
      [['', 'All'], ...labels.map((l) => /** @type {[string, string]} */ ([l.name, l.name]))],
      f.label || 'all', params),
    dropdown('group', 'Group by', f.group, [['', 'None'], ['epic', 'Epic'], ['agent', 'Agent']], f.group || 'none', params),
    h('span', { class: 'toolbar-note' }, f.all
      ? ['Done shows every task · ', h('a', { href: boardHref(params, { done: '' }), 'data-key': 'done-recent' }, 'Show the last 7 days')]
      : 'Done shows the last 7 days'));
}

// ------------------------------------------------------------------------------------------------
// Cards, columns, swimlanes
// ------------------------------------------------------------------------------------------------

/** A blocking reason's chip: [text, class]. @param {any} b */
function blockerChip(b) {
  switch (b.kind) {
    case 'dependency': return [`Waiting on #${b.id}`, 'chip-dep'];
    case 'human': return ['Waiting on you', 'chip-you'];
    case 'agent': return [`Question to ${b.name}`, 'chip-dep'];
    case 'any': return ['Question to any agent', 'chip-dep'];
    default: return null;
  }
}

/** @param {any} c a card of the view @param {number} now */
function cardEl(c, now) {
  const chips = (c.blockers ?? []).map(blockerChip).filter(Boolean);
  if (c.stalled) chips.push([Number.isFinite(c.stalled.since) ? `No agent for ${duration(now - c.stalled.since)}` : 'No agent', 'chip-idle']);
  const who = c.column === 'done' ? c.completer : c.assignee; // Done: who completed it
  const meta = metaText(c.meta, now);
  return h('article', { class: 'card', 'data-testid': `card-${c.id}` },
    h('div', { class: 'card-top' },
      h('span', { class: 'card-id' }, `#${c.id}`),
      c.suggested && h('span', { class: 'badge-suggested', 'data-testid': 'badge-suggested' }, 'suggested'),
      c.firstLabel && h('span', { class: 'card-label bidi', dir: 'auto', title: c.firstLabel, 'data-testid': 'label-chip' }, c.firstLabel)),
    h('a', { class: 'card-title', href: `#/task/${c.id}`, 'data-testid': 'task-title', 'data-key': `card-${c.id}` }, bidi(c.title)),
    c.epicPath && h('span', { class: 'card-epic', 'data-testid': 'epic-path' }, bidi(c.epicPath)),
    chips.length > 0 && h('div', { class: 'card-chips' },
      chips.map(([text, cls]) => h('span', { class: ['card-chip', cls], 'data-testid': 'reason-chip' }, text))),
    (who || meta) && h('div', { class: 'card-foot' },
      who && h('span', { class: 'card-agent', 'data-testid': 'holder' }, avatar(who), h('span', { class: 'card-agent-name' }, who.name)),
      meta && h('span', { class: 'card-meta', 'data-testid': 'meta-text' }, meta)));
}

/**
 * The cards of one column (of one lane), with their limit: Backlog and Ready the first LIMIT, then
 * "+ N more" (which opens and closes); Done the ones done since `ctx.since`, then "See all N".
 * @param {any[]} list the column's cards, in board order @param {string} key the column
 * @param {string} lane the lane's key ("all" without swimlanes)
 * @param {{ now: number, since: number, f: Filters, params: Record<string, string>, rerender: () => void }} ctx
 */
function cellCards(list, key, lane, ctx) {
  let shown = list;
  let more = null;
  if (LIMITED.has(key) && list.length > LIMIT) {
    const id = `${lane}:${key}`;
    const open = expanded.has(id);
    if (!open) shown = list.slice(0, LIMIT);
    more = h('button', {
      type: 'button', class: 'more', 'aria-expanded': open, 'data-testid': 'column-more', 'data-key': `more-${lane}-${key}`,
      onclick: () => {
        if (open) expanded.delete(id);
        else expanded.add(id);
        ctx.rerender();
      },
    }, open ? 'Show fewer' : `+ ${list.length - LIMIT} more`);
  } else if (key === 'done' && !ctx.f.all) {
    shown = list.filter((c) => recent(c, ctx.since));
    if (shown.length < list.length) more = seeAll(list.length, `see-all-${lane}`, ctx.params);
  }
  return [shown.map((c) => cardEl(c, ctx.now)), more];
}

/** Is the card shown without done=all: not Done, or done since `since`? @param {any} c @param {number} since */
const recent = (c, since) => c.column !== 'done' || (Number.isFinite(c.doneAt) && c.doneAt >= since);

/** "See all N": shows every Done card. @param {number} n @param {string} key its data-key @param {Record<string, string>} params */
const seeAll = (n, key, params) => h('a', { class: 'more', href: boardHref(params, { done: 'all' }), 'data-testid': 'done-see-all', 'data-key': key }, `See all ${n}`);

/** The cards of each column. @param {any[]} cards @returns {Map<string, any[]>} */
function byColumn(cards) {
  const out = new Map(COLUMNS.map(([key]) => [key, []]));
  for (const c of cards) out.get(c.column)?.push(c);
  return out;
}

/** A column's header: the dot, the name in capitals, the count. @param {string} key @param {string} name @param {number} count */
const columnHead = (key, name, count) => h('div', { class: 'column-head' },
  h('span', { class: `dot dot-${key}`, 'aria-hidden': 'true' }),
  h('h2', { class: 'column-name' }, name.toUpperCase()),
  h('span', { class: 'column-count', 'data-testid': 'column-count' }, count));

/** The five columns. @param {any[]} cards @param {Parameters<typeof cellCards>[3]} ctx */
function columns(cards, ctx) {
  const cols = byColumn(cards);
  return h('div', { class: 'columns' }, COLUMNS.map(([key, name]) => {
    const list = /** @type {any[]} */ (cols.get(key));
    return h('section', { class: 'column', 'data-testid': `column-${key}`, 'aria-label': name },
      columnHead(key, name, list.length),
      cellCards(list, key, 'all', ctx));
  }));
}

/**
 * The swimlanes of `cards`, in order.
 * - epic: one per epic, in the sidebar's order, holding the tasks whose nearest epic it is; then
 *   "No epic".
 * - agent: one per live agent, in arrival order, holding the tasks it holds and the Done tasks it
 *   completed (any other agent after them); then "No agent" (stalled cards) and "Unassigned" (no
 *   holder, and Done tasks whose completer the registry does not know).
 * Empty lanes are left out.
 * @param {'epic' | 'agent'} group @param {any[]} cards @param {any} view @returns {Lane[]}
 */
function lanesOf(group, cards, view) {
  /** @type {Map<string, Lane>} */
  const lanes = new Map();
  /** @param {string} key @param {string} name @param {Node | null} marker @param {boolean} [sub] */
  const lane = (key, name, marker, sub = false) => {
    if (!lanes.has(key)) lanes.set(key, { key, name, cards: [], marker, sub });
    return /** @type {Lane} */ (lanes.get(key));
  };
  if (group === 'epic') {
    const epics = view.epics ?? [];
    const mark = () => h('span', { class: 'epic-mark', 'aria-hidden': 'true' });
    for (const e of epics) lane(`epic-${e.id}`, e.title, mark(), e.depth === 1);
    // every epic's lane exists by now, so "No epic" comes last
    for (const c of cards) (lanes.get(`epic-${c.epicIds[0]}`) ?? lane('no-epic', 'No epic', null)).cards.push(c);
  } else {
    for (const a of view.agents ?? []) lane(`agent-${a.id}`, a.name, avatar(a));
    const unheld = [];
    const stalled = [];
    for (const c of cards) {
      const who = c.assignee ?? (c.column === 'done' && c.completer?.id ? c.completer : null);
      if (c.stalled) stalled.push(c);
      else if (who) lane(`agent-${who.id}`, who.name, avatar(who)).cards.push(c);
      else unheld.push(c);
    }
    if (stalled.length) lane('agent-none', 'No agent', avatar(null)).cards.push(...stalled);
    if (unheld.length) lane('unassigned', 'Unassigned', null).cards.push(...unheld);
  }
  return [...lanes.values()].filter((l) => l.cards.length > 0);
}

/**
 * The column heads over every lane, counting every card that passed the filters, with one "See all N"
 * under Done; then one lane per group, of the cards shown (without done=all, Done tasks older than
 * the last 7 days are left out, and so is a lane left empty).
 * @param {'epic' | 'agent'} group @param {any[]} cards the cards that passed the filters @param {any} view
 * @param {Parameters<typeof cellCards>[3]} ctx
 */
function swimlanes(group, cards, view, ctx) {
  const cols = byColumn(cards);
  const shown = ctx.f.all ? cards : cards.filter((c) => recent(c, ctx.since));
  const done = /** @type {any[]} */ (cols.get('done')).length;
  const lanes = lanesOf(group, shown, view);
  return h('div', { class: 'lanes' },
    h('div', { class: 'lane-heads' }, COLUMNS.map(([key, name]) => h('div', { class: 'lane-head-cell', 'data-testid': `column-${key}` },
      columnHead(key, name, /** @type {any[]} */ (cols.get(key)).length),
      key === 'done' && shown.length < cards.length && seeAll(done, 'see-all-lanes', ctx.params)))),
    lanes.map((l) => {
      const laneCols = byColumn(l.cards);
      return h('section', { class: 'lane', 'data-testid': 'lane', 'aria-label': l.name },
        h('div', { class: 'lane-head' },
          l.marker,
          h('h3', { class: 'lane-name bidi', dir: 'auto', 'data-testid': 'lane-name', title: l.name }, l.name),
          l.sub && h('span', { class: 'sub-epic' }, 'sub-epic'),
          h('span', { class: 'lane-count', 'data-testid': 'lane-count' }, plural(l.cards.length, 'task'))),
        h('div', { class: 'lane-row' }, COLUMNS.map(([key, name]) => h('div', { class: 'lane-cell', role: 'group', 'aria-label': name, 'data-testid': `lane-cell-${key}` },
          cellCards(/** @type {any[]} */ (laneCols.get(key)), key, l.key, ctx)))));
    }));
}

/** @param {string} text @param {Record<string, string>} params */
function emptyState(text, params) {
  const cleared = Object.fromEntries(FILTERS.map((k) => [k, '']));
  return h('div', { class: 'board-empty', 'data-testid': 'board-empty' },
    h('p', { class: 'board-empty-text' }, text),
    h('a', { href: boardHref(params, cleared), 'data-key': 'clear-filters' }, 'Clear filters'));
}

// ------------------------------------------------------------------------------------------------

/** @param {ViewContext} ctx @returns {Node} */
export function board({ view, route, now, rerender }) {
  const { params } = route;
  const f = filtersOf(params);
  const cards = view.cards ?? [];
  const found = f.q ? searchFor(f.q, Number.isSafeInteger(view.seq) ? view.seq : 0, rerender) : null;
  const since = (Number.isFinite(view.now) ? view.now : now) - DONE_WINDOW;
  const ctx = { now, since, f, params, rerender };

  /** @type {Node | Node[]} */
  let content;
  if (found && !found.ids) {
    content = found.failedAt != null
      ? emptyState('The search could not run. It is tried again shortly.', params)
      : h('p', { class: 'page-note', 'data-testid': 'board-searching' }, 'Searching…');
  } else {
    const shown = cards.filter(matcher(f, found?.ids ?? null));
    if (shown.length === 0 && FILTERS.some((k) => f[/** @type {keyof Filters} */ (k)])) content = emptyState('No tasks match these filters.', params);
    else {
      content = [
        found && found.total > /** @type {Set<number>} */ (found.ids).size
          && h('p', { class: 'page-note' }, `The search matched ${found.total} tasks; the board shows the first ${/** @type {Set<number>} */ (found.ids).size}.`),
        f.group ? swimlanes(f.group, shown, view, ctx) : columns(shown, ctx),
      ].filter(Boolean);
    }
  }

  return h('div', { class: 'board', 'data-testid': 'board' },
    sidebar(view, f, params),
    h('div', { class: 'board-main' },
      needsStrip(view.needsYou, now),
      toolbar(view, f, params),
      content));
}
