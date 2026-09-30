import { h, icon } from '../dom.js';
import { askLine, duration, plural, timeAgo } from '../format.js';

/**
 * The Overview, the home page (spec section 13 Overview; docs/design/mockups/overview.html).
 * Left column: Needs you, Now, Shipped today. Right column: Epics, Where the work is, Next in line.
 *
 * The app builds it again on every load and every 30 s, so it keeps no state in the DOM:
 * - every focusable element has a stable `data-key`, so focus survives a render (app.js);
 * - a copy button's "Copied" confirmation lives in `copiedAt`, by the button's key, so the next
 *   render shows it for the rest of its 2 s;
 * - board times are relative to the view's `now`.
 *
 * @typedef {import('../app.js').ViewContext} ViewContext
 */

/** How long a copy button reads "Copied". */
const COPIED_MS = 2_000;
/** When each copy button last copied, by its data-key (this browser's clock). */
const copiedAt = new Map();

/** The columns of "Where the work is", in board order: [key in view.counts, label]. */
const COLUMNS = [['backlog', 'Backlog'], ['ready', 'Ready'], ['in_progress', 'In progress'], ['blocked', 'Blocked'], ['done', 'Done']];

/** A Needs-you item's chip: its text and tone. */
const KINDS = { question: ['QUESTION', 'tone-warn'], approve: ['APPROVE', 'tone-accent'], stalled: ['STALLED', 'tone-neutral'] };
/** A Now card's pill tone. */
const PILLS = { 'In progress': 'tone-accent', Blocked: 'tone-warn' };

/** A share in whole percents, 0 when there is nothing. @param {number} part @param {number} whole */
const percent = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/** Board text (titles, questions, summaries) in its own direction. @param {string} text @param {string} [cls] */
const bidi = (text, cls) => h('span', { class: ['bidi', cls], dir: 'auto' }, text);

/** "#12 Title", linking to the task view. @param {number} id @param {string} title @param {string} key its data-key @param {string} [cls] */
const taskLink = (id, title, key, cls = 'task-link') => h('a', { class: cls, href: `#/task/${id}`, 'data-key': key },
  h('span', { class: 'task-id' }, `#${id}`), ' ', bidi(title));

/** A progress bar filled to `pct`. @param {number} pct @param {string} cls */
function bar(pct, cls) {
  const fill = h('span', { class: 'bar-fill' });
  fill.style.setProperty('--pct', `${pct}%`);
  return h('span', { class: ['bar', cls], 'aria-hidden': 'true' }, fill);
}

// ------------------------------------------------------------------------------------------------
// Needs you
// ------------------------------------------------------------------------------------------------

/** How long the button `key` still reads "Copied", 0 when it does not (then forgotten). @param {string} key */
function copiedLeft(key) {
  const left = (copiedAt.get(key) ?? -Infinity) + COPIED_MS - Date.now();
  if (left <= 0) copiedAt.delete(key);
  return Math.max(0, left);
}

/** Selects the contents of `el`, for the user to copy by hand. @param {Element} el */
function select(el) {
  const selection = window.getSelection();
  if (!selection || !el.isConnected) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * The "Ask:" box: the request and its copy button. The button copies with the clipboard API and
 * reads "Copied" for 2 s; when the browser refuses (the page is not focused, no permission), the
 * request is selected instead.
 * @param {string} text @param {string} key the button's data-key
 * @param {boolean} open the request ends where the user types (an answer)
 */
function askBox(text, key, open) {
  const request = h('span', { class: ['ask-text', open && 'ask-open'], 'data-testid': 'ask-text' }, text);
  const button = h('button', { type: 'button', class: 'copy', 'data-testid': 'copy', 'data-key': key, onclick: () => void copy() });
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const show = () => {
    const left = copiedLeft(key);
    button.classList.toggle('is-copied', left > 0);
    button.replaceChildren(...(left > 0
      ? [icon('check', 14), h('span', null, 'Copied')]
      : [icon('copy', 16), h('span', { class: 'sr-only' }, 'Copy request')]));
    clearTimeout(timer);
    if (left > 0) timer = setTimeout(show, left);
  };
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      select(request);
      return;
    }
    copiedAt.set(key, Date.now());
    show();
  }
  show();
  return h('div', { class: 'ask' }, h('span', { class: 'ask-label' }, 'Ask:'), request, button);
}

/**
 * The detail: `text`, then `meta`, on up to two lines (the whole of it in the tooltip).
 * @param {Node | string | (Node | string)[]} text @param {string} full `text` as plain text @param {string} [meta]
 */
const detail = (text, full, meta) => h('div', { class: 'needs-detail', 'data-testid': 'needs-detail', title: meta ? `${full} ${meta}` : full },
  h('span', { class: 'needs-detail-text' }, text),
  meta && [' ', h('span', { class: 'needs-detail-meta' }, meta)]);

/** @param {any} q a question to the human @param {number} now */
function questionRow(q, now) {
  const asked = [`asked by ${q.askedBy}`, Number.isFinite(q.at) && timeAgo(now - q.at)].filter(Boolean).join(' · ');
  return needsRow(q, `q-${q.questionId}`, q.taskId, q.title, detail(bidi(q.text), q.text, `· ${asked}`), true);
}

/** @param {any} a the grouped suggestions */
function approveRow(a) {
  const names = [...new Set(a.items.map((i) => i.suggestedBy))];
  const title = `${plural(a.items.length, 'task')} suggested by ${names.length === 1 ? names[0] : 'agents'}`;
  const list = a.items.flatMap((i, n) => [n > 0 && ', ', `#${i.id} `, bidi(i.title)]);
  const full = `Waiting in Backlog: ${a.items.map((i) => `#${i.id} ${i.title}`).join(', ')}`;
  return needsRow(a, 'approve', null, title, detail(['Waiting in Backlog: ', list], full));
}

/** @param {any} s a stalled claim @param {number} now */
function stalledRow(s, now) {
  const release = Number.isFinite(s.releaseAt) && s.releaseAt > now
    ? `released automatically in ${duration(s.releaseAt - now)}`
    : 'released at the next change';
  const text = `${s.holderName}'s session ended · ${release}`;
  return needsRow(s, `stalled-${s.id}`, s.id, s.title, detail(text, text));
}

/**
 * @param {{ kind: string }} item @param {string} key the row's key, unique in the list
 * @param {number | null} taskId the task the title links to; null: the title is plain text
 * @param {string} title @param {Node} detailLine @param {boolean} [open] see askBox
 */
function needsRow(item, key, taskId, title, detailLine, open = false) {
  const [chip, tone] = KINDS[/** @type {keyof typeof KINDS} */ (item.kind)];
  return h('div', { class: 'needs-row', 'data-testid': 'needs-you-row' },
    h('span', { class: ['kind-chip', tone] }, chip),
    h('div', { class: 'needs-body' },
      h('div', { class: 'needs-title' }, taskId == null ? title : taskLink(taskId, title, `link-${key}`)),
      detailLine),
    askBox(askLine(/** @type {any} */ (item)), `copy-${key}`, open));
}

/** Hidden (null) when nothing needs the human. @param {any} needs view.needsYou @param {number} now */
function needsYou(needs, now) {
  if (!needs || needs.count === 0) return null;
  return h('section', { class: ['panel', 'needs-you'], 'data-testid': 'needs-you', 'aria-labelledby': 'needs-you-title' },
    h('div', { class: 'needs-head' },
      h('h2', { class: 'section-title', id: 'needs-you-title' }, 'Needs you'),
      h('span', { class: 'count-badge', 'data-testid': 'needs-you-count' }, needs.count),
      h('span', { class: 'needs-note' }, 'The dashboard only shows. To act, ask any agent.')),
    needs.questions.map((q) => questionRow(q, now)),
    needs.approvals && approveRow(needs.approvals),
    needs.stalled.map((s) => stalledRow(s, now)));
}

// ------------------------------------------------------------------------------------------------
// Now, Shipped today
// ------------------------------------------------------------------------------------------------

/** @param {any} a an agent card of the view @param {number} now */
function agentCard(a, now) {
  const card = h('article', { class: 'agent-card', 'data-testid': 'agent-card' },
    h('div', { class: 'agent-head' },
      h('span', { class: 'avatar', 'aria-hidden': 'true' }, a.initial),
      h('span', { class: 'agent-name' }, a.name),
      h('span', { class: ['pill', PILLS[a.pill] ?? 'tone-neutral'] }, a.pill)),
    a.task && taskLink(a.task.id, a.task.title, `link-agent-${a.id}`, 'agent-task'),
    a.checklist && h('div', { class: 'agent-checklist' },
      bar(percent(a.checklist.done, a.checklist.total), 'bar-checklist'),
      h('span', { class: 'agent-checklist-text' }, `checklist ${a.checklist.done}/${a.checklist.total}`)),
    h('div', { class: 'agent-foot' },
      a.blockedReason ? h('span', { class: 'agent-blocked' }, a.blockedReason)
        : a.lastFile ? h('span', { class: 'agent-file', title: a.lastFile }, a.lastFile) : null,
      Number.isFinite(a.lastActivityAt) && h('span', { class: 'agent-when' }, timeAgo(now - a.lastActivityAt))));
  card.style.setProperty('--agent-color', a.color);
  return card;
}

/** @param {any[]} agents @param {number} now */
function nowSection(agents, now) {
  return h('section', { class: 'now', 'data-testid': 'now', 'aria-labelledby': 'now-title' },
    h('div', { class: 'section-head' },
      h('h2', { class: 'section-title', id: 'now-title' }, 'Now'),
      h('span', { class: 'section-note' }, 'who is doing what')),
    agents.length > 0
      ? h('div', { class: 'agent-grid' }, agents.map((a) => agentCard(a, now)))
      : h('p', { class: ['panel', 'now-empty'] }, 'No agent is working right now.'));
}

/** Hidden (null) when nothing was done today. @param {any[]} shipped @param {number} now */
function shippedToday(shipped, now) {
  if (shipped.length === 0) return null;
  return h('section', { class: ['panel', 'shipped'], 'data-testid': 'shipped-today', 'aria-labelledby': 'shipped-title' },
    h('div', { class: 'section-head shipped-head' },
      h('h2', { class: 'section-title', id: 'shipped-title' }, 'Shipped today'),
      h('span', { class: 'section-note' }, 'the summary each agent left when it finished')),
    shipped.map((s) => h('div', { class: 'shipped-row', 'data-testid': 'shipped-row' },
      icon('check-circle', 20),
      h('div', { class: 'shipped-body' },
        h('div', { class: 'shipped-title' },
          taskLink(s.id, s.title, `link-shipped-${s.id}`), ' ',
          h('span', { class: 'shipped-meta' }, `· ${s.agentName} · ${timeAgo(now - s.doneAt)}`)),
        s.summary && bidi(s.summary, 'shipped-summary')))));
}

// ------------------------------------------------------------------------------------------------
// Epics, Where the work is, Next in line
// ------------------------------------------------------------------------------------------------

/** @param {any[]} epics */
function epicsSection(epics) {
  return h('section', { class: ['panel', 'side-panel'], 'data-testid': 'epics', 'aria-labelledby': 'epics-title' },
    h('div', { class: 'panel-head' },
      h('h2', { class: 'section-title', id: 'epics-title' }, 'Epics'),
      h('a', { class: 'see-all', href: '#/board', 'data-key': 'epics-see-all' }, 'See all')),
    epics.length === 0 && h('p', { class: 'empty-note' }, 'No epics yet.'),
    epics.map((e) => h('a', {
      class: ['epic-row', e.depth === 1 && 'is-sub'], href: `#/board?epic=${e.id}`, 'data-testid': 'epic-row', 'data-key': `epic-${e.id}`,
    },
      h('span', { class: 'epic-line' },
        h('span', { class: 'bidi epic-name', dir: 'auto', 'data-testid': 'epic-name' }, e.title),
        e.depth === 1 && h('span', { class: 'sub-epic', 'data-testid': 'sub-epic' }, 'sub-epic'),
        h('span', { class: 'epic-count' }, `${e.done}/${e.total}`)),
      bar(percent(e.done, e.total), 'bar-epic'))));
}

/** @param {Record<string, number>} counts */
function workSection(counts) {
  const n = (key) => counts?.[key] ?? 0;
  const segments = COLUMNS.filter(([key]) => n(key) > 0).map(([key]) => {
    const seg = h('span', { class: ['stack-seg', `dot-${key}`], 'data-testid': 'bar-segment' });
    seg.style.setProperty('flex-grow', String(n(key)));
    return seg;
  });
  return h('section', { class: ['panel', 'side-panel'], 'data-testid': 'where-the-work-is', 'aria-labelledby': 'work-title' },
    h('h2', { class: 'section-title', id: 'work-title' }, 'Where the work is'),
    h('div', { class: ['stack', segments.length === 0 && 'is-empty'], 'aria-hidden': 'true' }, segments),
    h('div', { class: 'legend' }, COLUMNS.map(([key, label]) => h('div', { class: 'legend-row', 'data-testid': 'legend-row' },
      h('span', { class: ['swatch', `dot-${key}`] }),
      h('span', { 'data-testid': 'legend-name' }, label),
      h('span', { class: 'legend-count', 'data-testid': 'legend-count' }, n(key))))));
}

/** @param {any[]} next */
function nextSection(next) {
  return h('section', { class: ['panel', 'next'], 'data-testid': 'next-in-line', 'aria-labelledby': 'next-title' },
    h('h2', { class: 'section-title', id: 'next-title' }, 'Next in line'),
    h('span', { class: 'next-note' }, 'the next free agent takes the first one'),
    next.length === 0 && h('p', { class: 'empty-note next-empty' }, 'No task is ready.'),
    next.map((t) => h('div', { class: 'next-row', 'data-testid': 'next-row' },
      h('span', { class: 'next-pos' }, t.position),
      h('div', { class: 'next-body' },
        taskLink(t.id, t.title, `link-next-${t.id}`),
        t.epicPath && bidi(t.epicPath, 'next-epic')))));
}

// ------------------------------------------------------------------------------------------------

/** @param {ViewContext} ctx @returns {Node} */
export function overview({ view, now }) {
  return h('div', { class: 'overview' },
    h('h1', { class: 'sr-only' }, 'Overview'),
    h('div', { class: 'overview-col overview-main' },
      needsYou(view.needsYou, now),
      nowSection(view.agents ?? [], now),
      shippedToday(view.shippedToday ?? [], now)),
    h('div', { class: 'overview-col overview-side' },
      epicsSection(view.epics ?? []),
      workSection(view.counts),
      nextSection(view.nextInLine ?? [])));
}
