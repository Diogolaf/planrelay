import { copyButton } from '../copy.js';
import { h, icon } from '../dom.js';
import { askLine, duration, plural, timeAgo } from '../format.js';

/**
 * The task view, `#/task/<id>` (spec section 13 Task view; docs/design/mockups/task.html): the
 * breadcrumb, the title and a meta row; the question to the human, when one is open; then
 * Definition of done, Checklist and Conversation, beside the cards Details, Dependencies, Files
 * touched and Links. The data is /api/task/<id> (taskview.js TaskView), which app.js loads when the
 * page opens and again on every change.
 *
 * The app builds it again on every load and every 30 s, so it keeps no state in the DOM: links and
 * the copy button have stable data-keys, "Copied" outlives a render (copy.js), and times are
 * relative to the context's `now`. Board text goes in as text, and descriptions, messages and the
 * question with dir="auto" (the bidi class isolates them).
 *
 * @typedef {import('../app.js').ViewContext} ViewContext
 */

/** A column's name, for dependency pills. */
const COLUMN_NAMES = { backlog: 'Backlog', ready: 'Ready', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' };
/** A column's pill tone; an epic (no column) is neutral. */
const TONES = { backlog: 'tone-neutral', ready: 'tone-ready', in_progress: 'tone-accent', blocked: 'tone-warn', done: 'tone-done' };

/** @param {string | null} column */
const toneOf = (column) => (column != null && Object.hasOwn(TONES, column) ? TONES[/** @type {keyof typeof TONES} */ (column)] : 'tone-neutral');

/** Board text in its own direction. @param {string} text @param {string} [cls] */
const bidi = (text, cls) => h('span', { class: ['bidi', cls], dir: 'auto' }, text);

/** A name's initial, upper-case. @param {string} name */
const initialOf = (name) => (Array.from(name)[0] ?? '?').toUpperCase();

/**
 * An avatar: an agent's initial on its color, "Y" for the human, "S" for the system.
 * @param {'agent' | 'human' | 'system'} kind @param {string} name @param {string | null} color @param {string} size avatar-sm, avatar-md or avatar-lg
 */
function avatar(kind, name, color, size) {
  if (kind === 'human') return h('span', { class: ['avatar', size, 'avatar-you'], 'aria-hidden': 'true' }, 'Y');
  if (kind === 'system') return h('span', { class: ['avatar', size, 'avatar-system'], 'aria-hidden': 'true' }, 'S');
  const el = h('span', { class: ['avatar', size], 'aria-hidden': 'true' }, initialOf(name));
  if (color) el.style.setProperty('--agent-color', color);
  return el;
}

/** "#12 Title", linking to the task view. @param {{ id: number, title: string }} t @param {string} key its data-key @param {string} [cls] */
const taskLink = (t, key, cls = 'task-link') => h('a', { class: cls, href: `#/task/${t.id}`, 'data-key': key },
  h('span', { class: 'task-id' }, `#${t.id}`), ' ', bidi(t.title));

// ------------------------------------------------------------------------------------------------
// Top: breadcrumb, title, meta row; the question callout
// ------------------------------------------------------------------------------------------------

/** Board › epic › sub-epic › #id. @param {any} t */
function breadcrumb(t) {
  const sep = () => [' ', h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '›'), ' '];
  return h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb', 'data-testid': 'breadcrumb' },
    h('a', { href: '#/board', 'data-key': 'crumb-board' }, 'Board'),
    (t.breadcrumb ?? []).map((/** @type {any} */ e) => [sep(), h('a', { href: `#/board?epic=${e.id}`, 'data-key': `crumb-${e.id}` }, bidi(e.title))]),
    sep(),
    h('span', { class: 'crumb-here', 'aria-current': 'page' }, `#${t.id}`));
}

/** Who holds the task: "Jade has had it for 40 min", "Cobalt's session ended"; who completed it. @param {any} t @param {number} now */
function holder(t, now) {
  const a = t.assignee;
  if (a) {
    const text = a.gone ? `${a.name}'s session ended`
      : Number.isFinite(a.since) ? `${a.name} has had it for ${duration(now - a.since)}` : `${a.name} has it`;
    return h('span', { class: 'task-agent', 'data-testid': 'task-agent' }, avatar('agent', a.name, a.color, 'avatar-sm'), text);
  }
  if (t.completedByName) {
    const when = Number.isFinite(t.doneAt) ? ` ${timeAgo(now - t.doneAt)}` : '';
    return h('span', { class: 'task-agent', 'data-testid': 'task-agent' }, `completed by ${t.completedByName}${when}`);
  }
  return null;
}

/** @param {any} t @param {number} now */
function top(t, now) {
  return h('header', { class: 'task-top' },
    breadcrumb(t),
    h('h1', { class: 'task-title', 'data-testid': 'task-title' }, h('span', { class: 'task-title-id' }, `#${t.id}`), ' ', bidi(t.title)),
    h('div', { class: 'task-meta', 'data-testid': 'task-meta' },
      h('span', { class: ['status-pill', toneOf(t.status?.column ?? null)], 'data-testid': 'status-pill' }, t.status?.text ?? t.columnLabel),
      holder(t, now),
      (t.labels ?? []).map((/** @type {string} */ l) => bidi(l, 'label-chip')),
      h('span', { class: 'task-origin' }, t.origin)));
}

/** The open question to the human, and the request that answers it. @param {any} t @param {number} now */
function callout(t, now) {
  const q = t.question;
  const line = askLine({ kind: 'question', taskId: t.id });
  const request = h('span', { class: 'ask-text ask-open', 'data-testid': 'ask-text' }, line);
  return h('section', { class: 'callout', 'data-testid': 'question-callout', 'aria-labelledby': 'callout-head' },
    avatar('agent', q.authorName, q.authorColor, 'avatar-lg'),
    h('div', { class: 'callout-body' },
      h('h2', { class: 'callout-head', id: 'callout-head', 'data-testid': 'question-head', title: `Asked by ${q.authorName}` },
        Number.isFinite(q.at) ? `QUESTION FOR YOU · ${timeAgo(now - q.at).toUpperCase()}` : 'QUESTION FOR YOU'),
      h('p', { class: 'callout-text bidi', dir: 'auto', 'data-testid': 'question-text' }, q.text),
      h('div', { class: 'callout-ask' },
        h('span', { class: 'callout-ask-label' }, 'To answer, ask any agent:'),
        h('span', { class: 'callout-request' }, request, copyButton(line, `copy-answer-${t.id}`, request)))));
}

// ------------------------------------------------------------------------------------------------
// Main column: Definition of done, Checklist, Conversation
// ------------------------------------------------------------------------------------------------

/** @param {any} t */
function description(t) {
  return h('section', { class: 'task-section', 'aria-labelledby': 'dod-title' },
    h('h2', { class: 'task-h2', id: 'dod-title' }, t.kind === 'epic' ? 'Description' : 'Definition of done'),
    t.description
      ? h('p', { class: 'task-description bidi', dir: 'auto', 'data-testid': 'description' }, t.description)
      : h('p', { class: 'empty-note' }, 'No description yet.'));
}

/** Hidden (null) when the task has no checklist. @param {any} t */
function checklist(t) {
  const list = t.checklist;
  if (!list || !(list.total > 0)) return null;
  return h('section', { class: 'task-section', 'data-testid': 'checklist', 'aria-labelledby': 'checklist-title' },
    h('h2', { class: 'task-h2', id: 'checklist-title' }, 'Checklist', ' ', h('span', { class: 'task-h2-note' }, `· ${list.done} of ${list.total}`)),
    h('ul', { class: 'checklist' }, list.items.map((/** @type {any} */ i) => h('li', { class: ['check-item', i.done && 'is-done'], 'data-testid': 'checklist-item' },
      h('span', { class: 'check-box', role: 'img', 'aria-label': i.done ? 'done' : 'open' }, i.done && icon('check', 13)),
      bidi(i.text)))));
}

/** A conversation entry's tag tone. @param {string} tag */
function tagTone(tag) {
  if (tag.startsWith('QUESTION')) return 'tone-warn';
  switch (tag) {
    case 'COMMENT': return 'tone-neutral';
    case 'HANDOFF': return 'tone-accent';
    case 'ANSWER': return 'tone-ready';
    case 'SUMMARY': return 'tone-done';
    default: return 'tone-quiet'; // CREATED, AUTOMATIC
  }
}

/** @param {any} e a conversation entry @param {number} now */
function entry(e, now) {
  // the creation is the human's own request: just "You" (the agent that relayed it is not news)
  const author = e.relayedBy && e.tag !== 'CREATED' ? `${e.authorName} (relayed by ${e.relayedBy})` : e.authorName;
  return h('article', { class: 'entry', 'data-testid': 'conversation-entry' },
    avatar(e.authorKind, e.authorName, e.authorColor, 'avatar-md'),
    h('div', { class: 'entry-body' },
      h('div', { class: 'entry-head' },
        h('span', { class: 'entry-author', 'data-testid': 'entry-author' }, author),
        h('span', { class: ['entry-tag', tagTone(e.tag)], 'data-testid': 'entry-tag' }, e.tag),
        Number.isFinite(e.at) && h('span', { class: 'entry-when', 'data-testid': 'entry-when' }, timeAgo(now - e.at))),
      h('p', { class: 'entry-text bidi', dir: 'auto', 'data-testid': 'entry-text' }, e.text)));
}

/** Oldest first; the creation is the first entry. @param {any} t @param {number} now */
function conversation(t, now) {
  return h('section', { class: 'task-section conversation', 'aria-labelledby': 'conversation-title' },
    h('h2', { class: 'task-h2', id: 'conversation-title' }, 'Conversation'),
    (t.conversation ?? []).map((/** @type {any} */ e) => entry(e, now)));
}

// ------------------------------------------------------------------------------------------------
// Sidebar: Details, Dependencies, Files touched, Links
// ------------------------------------------------------------------------------------------------

/** A sidebar card. @param {string} testid @param {string} title @param {unknown} note after the title ("· 3"), or null @param {...unknown} children */
const card = (testid, title, note, ...children) => h('section', { class: 'panel side-card', 'data-testid': testid, 'aria-labelledby': `${testid}-title` },
  h('h2', { class: 'side-card-title', id: `${testid}-title` }, title, note != null && [' ', h('span', { class: 'side-card-note' }, '· ', note)]),
  children);

/** @param {any} t @param {number} now */
function details(t, now) {
  const d = t.details ?? {};
  const a = t.assignee;
  let agent = 'None';
  if (a) agent = a.gone ? `${a.name}, session ended` : Number.isFinite(a.since) ? `${a.name}, for ${duration(now - a.since)}` : a.name;
  else if (t.completedByName) agent = Number.isFinite(t.doneAt) ? `${t.completedByName}, done ${timeAgo(now - t.doneAt)}` : `${t.completedByName}, done`;
  /** @type {[string, string, unknown][]} [key, name, value] */
  const rows = [
    ['status', 'Status', d.status],
    ['agent', 'Agent', agent],
    ['epic', 'Epic', d.epic ? bidi(d.epic) : 'None'],
    ['labels', 'Labels', d.labels?.length ? bidi(d.labels.join(', ')) : 'None'],
    ['origin', 'Origin', d.origin],
    ['created', 'Created', Number.isFinite(d.createdAt) ? timeAgo(now - d.createdAt) : 'Unknown'],
  ];
  return card('details', 'Details', null,
    h('dl', { class: 'details' }, rows.map(([key, name, value]) => [h('dt', null, name), h('dd', { 'data-testid': `detail-${key}` }, value)])));
}

/** @param {any} t */
function dependencies(t) {
  /** @param {string} rel @param {string} key @param {any[]} list */
  const group = (rel, key, list) => list.length > 0 && h('div', { class: 'deps-group', 'data-testid': `deps-${key}` },
    h('span', { class: 'deps-rel', 'data-testid': 'deps-rel' }, rel),
    list.map((d) => h('div', { class: 'dep-row', 'data-testid': 'dep-row' },
      taskLink(d, `${key}-${d.id}`, 'task-link dep-link'),
      h('span', { class: ['dep-pill', toneOf(d.column)], 'data-testid': 'status-pill' },
        d.column != null && Object.hasOwn(COLUMN_NAMES, d.column) ? COLUMN_NAMES[/** @type {keyof typeof COLUMN_NAMES} */ (d.column)] : 'Epic'))));
  const dependsOn = t.dependsOn ?? [];
  const blocks = t.blocks ?? [];
  return card('dependencies', 'Dependencies', null,
    dependsOn.length + blocks.length === 0 && h('p', { class: 'empty-note' }, 'No dependencies.'),
    group('DEPENDS ON', 'depends-on', dependsOn),
    group('BLOCKS', 'blocks', blocks));
}

/** @param {any} t */
function files(t) {
  const list = t.files ?? [];
  return card('files', 'Files touched', h('span', { 'data-testid': 'files-count' }, t.filesMore ? `${list.length}+` : list.length),
    list.length === 0 && h('p', { class: 'empty-note' }, 'No files touched yet.'),
    list.map((/** @type {any} */ f) => h('div', { class: 'file-row', 'data-testid': 'file-row' },
      h('span', { class: 'file-path' }, f.path),
      h('span', { class: 'file-who' }, f.agentName))));
}

/** The host of a web link, or '' when it cannot be read. @param {string} href */
function hostOf(href) {
  try {
    return new URL(href).host;
  } catch {
    return '';
  }
}

/**
 * The task's links (a web page opens in a new tab; a repository path is shown as text), then the
 * task's timeline in the Activity feed (decision 7).
 * @param {any} t
 */
function links(t) {
  const { count = 0, truncated = false } = t.timeline ?? {};
  let timeline;
  if (count === 0) timeline = h('p', { class: 'empty-note', 'data-testid': 'timeline' }, 'No recent events in the activity log.');
  else {
    timeline = h('a', { class: 'side-link', href: `#/activity?task=${t.id}`, 'data-key': 'timeline', 'data-testid': 'timeline' },
      truncated ? `Showing the most recent ${plural(count, 'event')}` : `Full timeline · ${plural(count, 'event')}`);
  }
  return card('links', 'Links', null,
    (t.links ?? []).map((/** @type {any} */ l, /** @type {number} */ i) => h('div', { class: 'link-row', 'data-testid': 'link-row' },
      l.href
        ? [h('a', { class: 'side-link', href: l.href, target: '_blank', title: l.target, 'data-key': `link-${i}` }, bidi(l.title)),
          hostOf(l.href) && h('span', { class: 'link-host' }, ` · ${hostOf(l.href)}`)]
        : [bidi(l.title), ' · ', h('span', { class: 'mono link-path' }, l.target)])),
    timeline);
}

// ------------------------------------------------------------------------------------------------

/** "Task #N does not exist.", with the way back. @param {number | null} id */
function missing(id) {
  return h('div', { class: 'page task-missing', 'data-testid': 'task-missing' },
    h('h1', { class: 'page-title' }, `Task #${id} does not exist.`),
    h('p', { class: 'page-note' }, h('a', { href: '#/board', 'data-key': 'missing-board' }, 'Back to the Board')));
}

/** @param {ViewContext} ctx @returns {Node} */
export function task({ route, task: load, now }) {
  if (load?.error) return missing(route.id);
  const t = load?.data;
  if (!t) return h('div', { class: 'page' }, h('p', { class: 'page-note' }, 'Loading the task'));
  return h('div', { class: 'task-page', 'data-testid': 'task-view' },
    h('div', { class: 'task-main' },
      top(t, now),
      t.question && callout(t, now),
      description(t),
      checklist(t),
      conversation(t, now)),
    h('aside', { class: 'task-side', 'aria-label': 'Task details' },
      details(t, now),
      dependencies(t),
      files(t),
      links(t)));
}
