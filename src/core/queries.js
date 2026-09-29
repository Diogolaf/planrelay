import { getAgent, nameOf, statusOf } from './agents.js';
import { blockers, byRank, childrenIndex, columnOf, COLUMNS, epicPath, epicProgress, inEpic } from './derive.js';
import { lastActivity } from './maintenance.js';
import { BoardError, claimedBy, fieldsOf, got, taskNumber } from './ops.js';
import { displayName, newTask } from './reduce.js';

/**
 * Read-only views of the board for the agent tools (§8), the pings (§9) and the dashboard (§13).
 *
 * - Pure: no IO and no clock. Callers pass `now`, `since` and a task's messages.
 * - Results share no objects with the state, the registry or the arguments, so a caller may change
 *   them freely.
 * - Names (§4). History shows the name stored with the event, the author's name at the time, which
 *   stays right after the registry forgets the agent: messages, "suggested by", "requested via",
 *   "completed by". A task's current holder shows the registry's name first, like ops, because an
 *   agent that comes back can be renamed and other agents address it by its current name; then
 *   the name stored with the claim. nameOf's fallback is used only when no name is known.
 * - list_tasks passes tool arguments straight through (§14): an unknown field, a value of the
 *   wrong type and an unknown column, kind or epic are refused with a BoardError that says what to
 *   send; null means "not provided". `limit` is clamped instead (LIST_LIMIT).
 *
 * @typedef {import('./reduce.js').BoardState} BoardState
 * @typedef {import('./reduce.js').Task} Task
 * @typedef {import('./reduce.js').MessageHeader} MessageHeader
 * @typedef {import('./store.js').Registry} Registry
 * @typedef {import('./derive.js').Column} Column
 */

/** list_tasks page size: `default` when not a number, else clamped to `min`..`max`. */
export const LIST_LIMIT = Object.freeze({ default: 50, min: 1, max: 200 });

/** The filters list_tasks takes (§8). */
const FILTERS = ['column', 'epic', 'label', 'text', 'kind', 'changedSince', 'limit'];
const KINDS = ['task', 'epic'];
const EPIC_HELP = 'list_tasks with kind "epic" shows the epics';
/** The stored fields of a task (reduce.js newTask); a task view carries these and nothing else. */
const TASK_FIELDS = Object.freeze(Object.keys(newTask({})));
/** The fields of a message in a task's message file that a task view carries. */
const MESSAGE_FIELDS = ['id', 'taskId', 'author', 'authorName', 'kind', 'to', 'replyTo', 'relayedFromHuman', 'mentions', 'about', 'at', 'text'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** An own field's value; null and undefined both mean "not provided" (§14). */
const given = (obj, key) => (Object.hasOwn(obj, key) && obj[key] != null ? obj[key] : undefined);
/** The own `keys` of `obj` that it has, copied shallowly. */
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => Object.hasOwn(obj, k)).map((k) => [k, obj[k]]));

/** A history name: the one stored with the event when usable, else the registry's (nameOf). */
const writtenBy = (reg, id, name) => displayName(name) ?? nameOf(reg, id);
/** The same for a field that may be empty: null when neither an id nor a name was recorded. */
const writtenByOrNull = (reg, id, name) => (id == null && displayName(name) === undefined ? null : writtenBy(reg, id, name));

/** The name of a task's current holder (see the module note); null when nobody holds it. */
function holderName(reg, t) {
  if (!t.assignee) return null;
  return getAgent(reg, t.assignee)?.name ?? displayName(t.assigneeName) ?? nameOf(reg, t.assignee);
}

/**
 * Counts per column, plus how many Backlog tasks are agents' suggestions. Epics have no column.
 * @param {BoardState} state
 * @returns {Record<Column | 'suggested', number>}
 */
export function boardCounts(state) {
  /** @type {Record<string, number>} */
  const counts = { backlog: 0, ready: 0, in_progress: 0, blocked: 0, done: 0, suggested: 0 };
  for (const t of Object.values(state.tasks)) {
    const column = columnOf(t, state.tasks);
    if (!column) continue;
    counts[column] += 1;
    if (column === 'backlog' && t.origin === 'agent') counts.suggested += 1;
  }
  return counts;
}

/** The epic filter: an existing epic's id. */
function epicFilter(state, value) {
  const id = taskNumber(value, 'epic');
  const epic = Object.hasOwn(state.tasks, id) ? state.tasks[id] : undefined;
  if (!epic) throw new BoardError(`#${id} does not exist; ${EPIC_HELP}.`);
  if (epic.kind !== 'epic') throw new BoardError(`#${id} is not an epic; ${EPIC_HELP}.`);
  return id;
}

/** A text filter, trimmed and lower-cased; '' (no filter) when not given or blank. */
function searchText(value, help) {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new BoardError(`${help}${got(value)}.`);
  return value.trim().toLowerCase();
}

/** The page size: see LIST_LIMIT. */
function pageSize(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return LIST_LIMIT.default;
  return Math.min(LIST_LIMIT.max, Math.max(LIST_LIMIT.min, Math.trunc(value)));
}

/**
 * @typedef {{ id: number, title: string, column: Column | null, epic: string, labels: string[],
 *   assignee: string | null, suggested: boolean, progress: { done: number, total: number } | null }} ListItem
 */

/**
 * list_tasks (§8): tasks (or, with kind 'epic', epics with progress) in column order, then rank.
 * - column: one of COLUMNS; epic: an epic's id, matching tasks at any depth below it (inEpic, the
 *   rule of the progress bar), and sub-epics when kind is 'epic';
 * - label: one label, in any case and spacing; text: part of the title, the description or the
 *   epic path, in any case; a number, with or without "#", finds that id;
 * - changedSince: a Unix time in ms; limit: see LIST_LIMIT.
 * `total` counts every match; `items` holds the first `limit`.
 * @param {BoardState} state
 * @param {Registry} reg
 * @param {unknown} [input] { column?, epic?, label?, text?, kind?, changedSince?, limit? }
 * @returns {{ total: number, items: ListItem[] }}
 */
export function listTasks(state, reg, input) {
  const f = fieldsOf(input, FILTERS);
  const kind = given(f, 'kind') ?? 'task';
  if (!KINDS.includes(kind)) throw new BoardError(`kind must be "task" or "epic"${got(kind)}.`);
  const column = given(f, 'column');
  if (column !== undefined && !COLUMNS.includes(column)) throw new BoardError(`column must be one of ${COLUMNS.join(', ')}${got(column)}.`);
  const epicIn = given(f, 'epic');
  const epic = epicIn === undefined ? undefined : epicFilter(state, epicIn);
  // labels are stored one-line, NFC and lower-cased (ops)
  const label = searchText(given(f, 'label'), 'label must be text, such as "bug"').normalize('NFC').replace(/\s+/g, ' ');
  const text = searchText(given(f, 'text'), 'text must be text');
  const changedSince = given(f, 'changedSince');
  if (changedSince !== undefined && !Number.isFinite(changedSince)) {
    throw new BoardError(`changedSince must be a Unix time in milliseconds${got(changedSince)}.`);
  }
  const limit = pageSize(given(f, 'limit'));

  const idMatch = /^#?(\d+)$/.exec(text);
  let rows = Object.values(state.tasks)
    .filter((t) => t.kind === kind)
    .map((t) => ({ t, column: columnOf(t, state.tasks), epic: epicPath(t, state.tasks) }));
  if (column !== undefined) rows = rows.filter((r) => r.column === column);
  if (epic !== undefined) rows = rows.filter((r) => inEpic(r.t, epic, state.tasks));
  if (label) rows = rows.filter((r) => r.t.labels.some((l) => l.toLowerCase() === label));
  if (changedSince !== undefined) rows = rows.filter((r) => r.t.updatedAt >= changedSince);
  if (text) {
    rows = rows.filter((r) =>
      idMatch ? r.t.id === Number(idMatch[1]) : `${r.t.title} ${r.t.description} ${r.epic}`.toLowerCase().includes(text),
    );
  }
  rows.sort((a, b) => COLUMNS.indexOf(a.column) - COLUMNS.indexOf(b.column) || byRank(a.t, b.t));
  const children = kind === 'epic' ? childrenIndex(state.tasks) : undefined;
  return {
    total: rows.length,
    items: rows.slice(0, limit).map(({ t, column: col, epic: path }) => ({
      id: t.id,
      title: t.title,
      column: col,
      epic: path,
      labels: [...t.labels],
      assignee: holderName(reg, t),
      suggested: !t.approved && t.origin === 'agent',
      progress: t.kind === 'epic' ? epicProgress(t.id, state.tasks, children) : null,
    })),
  };
}

/**
 * get_task (§8) and the task view (§13): a copy of the task's stored fields (and nothing else a
 * snapshot may hold), with display names (see the module note) and:
 * - column; blockers, only when they are what puts it in Blocked (a Done task never waits);
 * - epicPath; blocks: the tasks that depend on it; for an epic, progress and its direct children;
 * - messages: the task's messages, from its message file, oldest first, with the message fields
 *   only and authorName; entries that are not objects are skipped.
 * @param {BoardState} state
 * @param {Registry} reg
 * @param {unknown} id a task number; anything else is refused like a tool's id (BoardError)
 * @param {unknown} [messages] from readMessages
 * @returns {null | Task & { column: Column | null, epicPath: string, blockers: ReturnType<typeof blockers>,
 *   blocks: number[], progress: { done: number, total: number } | null, children: number[],
 *   messages: (Partial<MessageHeader> & { authorName: string })[] }} null when no task has this number
 */
export function getTask(state, reg, id, messages = []) {
  const n = taskNumber(id, 'id');
  const t = Object.hasOwn(state.tasks, n) ? state.tasks[n] : undefined;
  if (!t) return null;
  const all = Object.values(state.tasks);
  const column = columnOf(t, state.tasks);
  return {
    ...structuredClone(pick(t, TASK_FIELDS)),
    createdByName: writtenBy(reg, t.createdBy, t.createdByName),
    requestedViaName: writtenByOrNull(reg, t.requestedVia, t.requestedViaName),
    assigneeName: holderName(reg, t),
    completedByName: writtenByOrNull(reg, t.completedBy, t.completedByName),
    column,
    epicPath: epicPath(t, state.tasks),
    blockers: column === 'blocked' ? blockers(t, state.tasks) : [],
    blocks: all.filter((o) => o.dependsOn.includes(t.id)).map((o) => o.id),
    progress: t.kind === 'epic' ? epicProgress(t.id, state.tasks) : null,
    children: t.kind === 'epic' ? all.filter((o) => o.parent === t.id).map((o) => o.id) : [],
    messages: (Array.isArray(messages) ? messages : [])
      .filter(isObj)
      .map((m) => ({ ...structuredClone(pick(m, MESSAGE_FIELDS)), authorName: writtenBy(reg, m.author, m.authorName) })),
  };
}

/** @typedef {{ reason: 'answer' | 'question' | 'update' | 'unblocked' | 'mention', message: MessageHeader, authorName: string }} Ping */

/**
 * Updates for one agent (§9), oldest first: answers to its questions, questions to it, other
 * messages addressed to it (such as "Released Amber's claim …" after the task left it), news on the
 * task it holds, and mentions of that task.
 * - Only messages committed after `afterSeq`, the agent's cursor: a board sequence number, never a
 *   time (§5 Agent), because a writer stamps its message before it gets the lock, so times can go
 *   backwards in commit order. When `since` is a finite number, only messages stamped at or after
 *   it as well: a filter, which never stands in for the cursor.
 * - Its own messages never count, nor do system notes on its task addressed to another agent,
 *   which are for that agent alone (the note to the former holder when this agent took over).
 * - An agentId that is not a non-empty string gets nothing. An afterSeq that is not a whole number
 *   of 0 or more means 0; a since that is not a finite number filters nothing; options that are
 *   not an object count as none. Nothing is ever coerced to a number.
 * @param {BoardState} state
 * @param {Registry} reg
 * @param {unknown} agentId
 * @param {unknown} [options] { afterSeq?: number, since?: number } since: a Unix time in ms
 * @returns {Ping[]}
 */
export function whatsNew(state, reg, agentId, options = {}) {
  if (typeof agentId !== 'string' || agentId === '') return [];
  const o = isObj(options) ? options : {};
  const seqIn = given(o, 'afterSeq');
  const afterSeq = Number.isSafeInteger(seqIn) && seqIn >= 0 ? seqIn : 0;
  const sinceIn = given(o, 'since');
  const since = Number.isFinite(sinceIn) ? sinceIn : null;
  const mine = claimedBy(state, agentId);
  /** @type {Ping[]} */
  const items = [];
  for (const m of state.messages) {
    if (!(m.seq > afterSeq) || (since !== null && !(m.at >= since)) || m.author === agentId) continue;
    /** @type {Ping['reason'] | null} */
    let reason = null;
    if (m.kind === 'answer' && m.replyToAuthor === agentId) reason = 'answer';
    else if (m.kind === 'question' && m.to === agentId) reason = 'question';
    else if (m.to === agentId) reason = 'update';
    else if (mine && m.taskId === mine.id) {
      const forAnother = m.author === 'system' && m.to != null;
      if (!forAnother) reason = m.about === 'unblocked' ? 'unblocked' : 'update';
    } else if (mine && m.mentions.includes(mine.id)) reason = 'mention';
    if (reason) items.push({ reason, message: { ...m, mentions: [...m.mentions] }, authorName: writtenBy(reg, m.author, m.authorName) });
  }
  return items;
}

/**
 * What the dashboard's "Needs you" shows (§13), in rank order: open questions to the human,
 * agents' suggestions awaiting approval, and claims whose holder is gone, with the time of the
 * automatic release. The countdown uses lastActivity, the rule housekeeping releases by, so it
 * ends when the claim is released.
 * @param {BoardState} state
 * @param {Registry} reg
 * @param {import('./config.js').Config} cfg
 * @param {number} now
 */
export function needsHuman(state, reg, cfg, now) {
  /** Who asked each question still in the message ring, as stored when it was asked. */
  const askers = new Map(state.messages.filter((m) => m.kind === 'question').map((m) => [m.id, m.authorName]));
  /** @type {{ taskId: number, title: string, question: import('./reduce.js').OpenQuestion, askedBy: string }[]} */
  const questions = [];
  /** @type {{ id: number, title: string, suggestedBy: string }[]} */
  const approvals = [];
  /** @type {{ id: number, title: string, since: number, releaseAt: number }[]} */
  const stalled = [];
  for (const t of Object.values(state.tasks).sort(byRank)) {
    if (t.done) continue;
    for (const q of t.openQuestions) {
      if (q.to === 'human') questions.push({ taskId: t.id, title: t.title, question: { ...q }, askedBy: writtenBy(reg, q.author, askers.get(q.id)) });
    }
    if (t.kind === 'task' && !t.approved && t.origin === 'agent') {
      approvals.push({ id: t.id, title: t.title, suggestedBy: writtenBy(reg, t.createdBy, t.createdByName) });
    }
    if (t.assignee && statusOf(getAgent(reg, t.assignee), now, cfg) === 'gone') {
      const last = lastActivity(t, reg);
      stalled.push({ id: t.id, title: t.title, since: last, releaseAt: last + cfg.claimTimeoutHours * 3_600_000 });
    }
  }
  return { questions, approvals, stalled };
}
