import { h } from '../dom.js';
import { timeAgo } from '../format.js';

/**
 * The Activity feed (spec section 13 Activity): the board's recent events, newest first, one row per
 * event with a dot colored by its type: "Jade completed #4 Search by ingredient", then the time ago.
 * It reads `view.activity`, the activity ring (the last 500 entries; file edits are never there).
 *
 * `#/activity?task=<id>` shows one task's events only: the task's timeline, which the task view's
 * "Full timeline" link opens. When the ring is full and no longer holds the task's creation, it says
 * "Showing the most recent N events" (decision 7).
 *
 * The app builds it again on every load and every 30 s: its links have stable data-keys, and times
 * are relative to the context's `now`.
 *
 * @typedef {import('../app.js').ViewContext} ViewContext
 */

/** The activity ring's size (core/reduce.js RECENT_LIMIT): a feed this long may have lost older events. */
const RING = 500;

/**
 * What each event type did, as the verb after the actor's name; "dependencies-done" reads
 * differently (see sentence). An unknown type (a newer board) shows its own name.
 */
const VERBS = {
  created: 'created',
  suggested: 'suggested',
  approved: 'approved',
  claimed: 'claimed',
  checked: 'checked off an item in',
  question: 'asked on',
  answer: 'answered on',
  completed: 'completed',
  released: 'released',
  unblocked: 'auto-unblocked',
  'auto-released': 'auto-released',
};
/** Types whose text says more than the task's title (the item, the question, the note): shown under the row. */
const DETAILED = new Set(['checked', 'question', 'answer', 'unblocked', 'dependencies-done']);

/** Board text in its own direction. @param {string} text @param {string} [cls] */
const bidi = (text, cls) => h('span', { class: ['bidi', cls], dir: 'auto' }, text);

/** The actor as shown: system notes read "System". @param {string} name */
const actorOf = (name) => (name === 'system' ? 'System' : name);

/**
 * A row's sentence: the actor, the verb, the task.
 * @param {any} e an activity entry of the view @param {string} key the task link's data-key
 */
function sentence(e, key) {
  const actor = h('span', { class: 'ev-actor' }, actorOf(e.actorName));
  if (e.type === 'dependencies-done') {
    return [actor, ': dependencies of ', h('a', { class: 'task-link', href: `#/task/${e.taskId}`, title: e.taskTitle ?? null, 'data-key': key },
      h('span', { class: 'task-id' }, `#${e.taskId}`)), ' are done'];
  }
  const verb = Object.hasOwn(VERBS, e.type) ? VERBS[/** @type {keyof typeof VERBS} */ (e.type)] : e.type;
  return [actor, ` ${verb} `, h('a', { class: 'task-link', href: `#/task/${e.taskId}`, 'data-key': key },
    h('span', { class: 'task-id' }, `#${e.taskId}`), e.taskTitle != null && [' ', bidi(e.taskTitle)])];
}

/** @param {any} e @param {string} key see sentence @param {number} now */
function row(e, key, now) {
  return h('div', { class: 'ev-row', 'data-testid': 'activity-row', 'data-type': e.type },
    h('span', { class: ['ev-dot', `ev-${e.type}`], 'data-testid': 'activity-dot', 'aria-hidden': 'true' }),
    h('div', { class: 'ev-body' },
      h('div', { class: 'ev-line' }, sentence(e, key)),
      DETAILED.has(e.type) && e.text && h('div', { class: 'ev-detail bidi', dir: 'auto', 'data-testid': 'activity-detail' }, e.text)),
    Number.isFinite(e.at) && h('span', { class: 'ev-when' }, timeAgo(now - e.at)));
}

/** @param {ViewContext} ctx @returns {Node} */
export function activity({ view, route, now }) {
  const all = view.activity ?? [];
  const raw = route.params.task ?? '';
  const id = /^[1-9]\d{0,14}$/.test(raw) ? Number(raw) : null;
  const rows = id == null ? all : all.filter((/** @type {any} */ e) => e.taskId === id);

  /** @type {unknown} */
  let head;
  if (id == null) {
    head = [h('h1', { class: 'page-title' }, 'Activity'), h('span', { class: 'section-note' }, 'what happened on the board, newest first')];
  } else {
    const title = rows.find((/** @type {any} */ e) => e.taskTitle != null)?.taskTitle
      ?? [...(view.cards ?? []), ...(view.epics ?? [])].find((c) => c.id === id)?.title ?? null;
    head = [
      h('h1', { class: 'page-title' }, `Timeline of #${id}`),
      h('span', { class: 'activity-links' },
        title != null && [h('a', { class: 'task-link', href: `#/task/${id}`, 'data-key': 'activity-task' }, bidi(title)), ' · '],
        h('a', { href: '#/activity', 'data-key': 'activity-all' }, 'Show all activity')),
    ];
  }
  const truncated = id != null && rows.length > 0 && all.length >= RING
    && !rows.some((/** @type {any} */ e) => e.type === 'created' || e.type === 'suggested');

  // entries of one event share its seq: their keys count within it
  /** @type {Map<number, number>} */
  const seen = new Map();
  const keyOf = (/** @type {any} */ e) => {
    const n = seen.get(e.seq) ?? 0;
    seen.set(e.seq, n + 1);
    return `ev-${e.seq}-${n}`;
  };

  return h('div', { class: 'activity' },
    h('div', { class: 'activity-head', 'data-testid': 'activity-heading' }, head),
    truncated && h('p', { class: 'page-note' }, `Showing the most recent ${rows.length} events`),
    rows.length === 0
      ? h('p', { class: 'panel activity-empty', 'data-testid': 'activity-empty' },
        id == null ? 'Nothing has happened on the board yet.' : 'No recent events in the activity log.')
      : h('div', { class: 'panel ev-list' }, rows.map((/** @type {any} */ e) => row(e, keyOf(e), now))));
}
