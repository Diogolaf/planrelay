/**
 * Names (createdByName, requestedViaName, assigneeName, completedByName, authorName, actorName) are display names
 * as they were when the event was written, so history stays readable after the registry forgets an agent
 * (§4); null when the event had none. requestedVia: the agent that relayed a task the human asked for.
 * @typedef {{ text: string, done: boolean }} ChecklistItem
 * @typedef {{ id: string, to: string, author: string | null, authorName: string | null, at: number | null, text: string }} OpenQuestion
 * @typedef {{
 *   id: number, kind: 'task' | 'epic', title: string, description: string, parent: number | null,
 *   labels: string[], dependsOn: number[], origin: 'human' | 'agent', createdBy: string, createdByName: string | null,
 *   requestedVia: string | null, requestedViaName: string | null, approved: boolean, rank: number,
 *   assignee: string | null, assigneeName: string | null, claim: { folder: string | null, since: number | null } | null,
 *   done: boolean, doneAt: number | null, completedBy: string | null, completedByName: string | null, summary: string | null,
 *   checklist: ChecklistItem[], files: { path: string, by: string | null, at: number | null }[],
 *   links: { title: string, target: string }[], openQuestions: OpenQuestion[],
 *   lastHandoff: { author: string | null, at: number | null, kind: string, text: string } | null,
 *   messageCount: number, createdAt: number | null, updatedAt: number | null
 * }} Task
 * @typedef {{ seq: number, at: number | null, type: string, taskId: number, actor: string | null, actorName: string | null,
 *   text: string }} Activity
 * A message ring entry carries its event's seq: sequence numbers grow in commit order, while times can
 * go backwards (a writer reads its clock before it gets the lock), so pings follow seq (§5 Agent cursor).
 * holder: the task's assignee when the message was applied, or null, so news on a task reaches the
 * agent that held it then, even after it completed or released the task (§9).
 * @typedef {{ id: string, seq: number, taskId: number, author: string | null, authorName: string | null, kind: string,
 *   to: string | null, replyTo: string | null, replyToAuthor: string | null, mentions: number[],
 *   relayedFromHuman: boolean, about: string | null, holder: string | null, at: number | null, text: string }} MessageHeader
 * @typedef {{ schema: number, seq: number, nextId: number, eventsSize: number,
 *   tasks: Record<number, Task>, recent: Activity[], messages: MessageHeader[] }} BoardState
 * actorName: the actor's display name when the event was written (store.stamp); null for system and unknown actors.
 * @typedef {{ seq: number, at: number, type: string, actor: string, actorName?: string | null, data: any }} BoardEvent
 */

/**
 * The snapshot's shape. A snapshot of another schema is not trusted: the log is replayed
 * (2: ring entries carry seq; 3: activity entries carry actorName).
 */
export const SCHEMA = 3;
export const RECENT_LIMIT = 500;
export const MESSAGE_RING = 300;
/** Files listed per task; touchTaskFile stops recording there, and the UI shows "200+". */
export const FILES_LIMIT = 200;
const SNIPPET = 280;
/** Display names in events longer than this are ignored. */
const NAME_MAX = 60;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isId = (v) => Number.isSafeInteger(v) && v >= 1;
const isStr = (v) => typeof v === 'string';
const strOrNull = (v) => (isStr(v) ? v : null);
/** A display name: trimmed, 1 to NAME_MAX characters; undefined when unusable. */
export const displayName = (v) => {
  const s = isStr(v) ? v.trim() : '';
  return s !== '' && s.length <= NAME_MAX ? s : undefined;
};

/** Each settable task field: the clean value, or undefined when the value is unusable. */
const FIELDS = {
  id: (v) => (isId(v) ? v : undefined),
  kind: (v) => (v === 'task' || v === 'epic' ? v : undefined),
  title: (v) => (isStr(v) ? v : undefined),
  description: (v) => (isStr(v) ? v : undefined),
  parent: (v) => (v === null || isId(v) ? v : undefined),
  labels: (v) => (Array.isArray(v) ? v.filter(isStr) : undefined),
  dependsOn: (v) => (Array.isArray(v) ? [...new Set(v.filter(isId))] : undefined),
  links: (v) => (Array.isArray(v)
    ? v.filter((l) => isObj(l) && isStr(l.title) && isStr(l.target)).map((l) => ({ title: l.title, target: l.target }))
    : undefined),
  origin: (v) => (v === 'human' || v === 'agent' ? v : undefined),
  createdBy: (v) => (isStr(v) ? v : undefined),
  createdByName: displayName,
  requestedVia: (v) => (isStr(v) && v !== '' ? v : undefined), // an agent id: kept exactly as given
  requestedViaName: displayName,
  approved: (v) => (typeof v === 'boolean' ? v : undefined),
  rank: (v) => (Number.isFinite(v) ? v : undefined),
};
/** What task.created may set (the event table); derived state always starts from newTask's defaults. */
const CREATE_FIELDS = [
  'id', 'kind', 'title', 'description', 'parent', 'labels', 'dependsOn', 'links', 'origin', 'createdBy', 'createdByName',
  'requestedVia', 'requestedViaName', 'approved', 'rank',
];
/** The only fields task.updated may change. */
const EDITABLE = ['title', 'description', 'parent', 'labels', 'dependsOn', 'rank', 'links'];
/** Task fields that must always be arrays. */
const LISTS = ['labels', 'dependsOn', 'links', 'checklist', 'files', 'openQuestions'];

/** The usable values among `keys` of `src` (own properties only); unusable ones are left out. */
function pick(src, keys) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const k of keys) {
    if (!Object.hasOwn(src, k)) continue;
    const v = FIELDS[k](src[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** An existing task by numeric id; never matches inherited keys ("__proto__") or strings ("1"). */
const taskAt = (state, id) => (Number.isSafeInteger(id) && Object.hasOwn(state.tasks, id) ? state.tasks[id] : undefined);

/** @returns {BoardState} */
export function emptyState() {
  return { schema: SCHEMA, seq: 0, nextId: 1, eventsSize: 0, tasks: {}, recent: [], messages: [] };
}

/** True for anything shaped like a log event: a plain object with a string type and a seq of 1 or more. */
export function isEvent(ev) {
  return isObj(ev) && isStr(ev.type) && Number.isSafeInteger(ev.seq) && ev.seq >= 1;
}

/** One-line, bounded version of a text for rings and pings. Never splits a surrogate pair. */
export function snippet(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= SNIPPET) return t;
  let end = SNIPPET - 1;
  const last = t.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // a high surrogate whose pair would be cut off
  return `${t.slice(0, end)}…`;
}

/** True when `text` is a snippet() that was cut short: it then ends with "…" at the snippet's length. */
export function wasCut(text) {
  return typeof text === 'string' && text.length >= SNIPPET - 1 && text.endsWith('…');
}

/** @param {Partial<Task>} fields @returns {Task} */
export function newTask(fields) {
  /** @type {any} */
  const t = {
    id: 0, kind: 'task', title: '', description: '', parent: null, labels: [], dependsOn: [],
    origin: 'human', createdBy: 'human', createdByName: null, requestedVia: null, requestedViaName: null, approved: true, rank: 0,
    assignee: null, assigneeName: null, claim: null, done: false, doneAt: null, completedBy: null, completedByName: null, summary: null,
    checklist: [], files: [], links: [], openQuestions: [], lastHandoff: null, messageCount: 0,
    createdAt: 0, updatedAt: 0,
    ...fields,
  };
  for (const k of LISTS) if (!Array.isArray(t[k])) t[k] = [];
  return t;
}

function push(ring, item, limit) {
  ring.push(item);
  if (ring.length > limit) ring.splice(0, ring.length - limit);
}

/**
 * Applies one event. Tolerant by design: anything malformed (not an event, missing or wrong-typed
 * data, unknown task) changes nothing, and nothing stored is `undefined`, so a snapshot and a replay
 * of the log always agree. seq must strictly increase, so applying an event twice is a no-op.
 * @param {BoardState} state @param {BoardEvent} ev @returns {BoardState}
 */
export function applyEvent(state, ev) {
  if (!isEvent(ev) || ev.seq <= state.seq) return state;
  state.seq = ev.seq;
  const d = isObj(ev.data) ? ev.data : {};
  const at = Number.isFinite(ev.at) ? ev.at : null;
  const actor = strOrNull(ev.actor);
  const actorName = displayName(ev.actorName) ?? null;
  const log = (type, taskId, text) =>
    push(state.recent, { seq: ev.seq, at, type, taskId, actor, actorName, text: snippet(text) }, RECENT_LIMIT);

  if (ev.type === 'task.created') {
    const src = d.task;
    if (!isObj(src) || !isId(src.id) || Object.hasOwn(state.tasks, src.id)) return state;
    const t = newTask({ ...pick(src, CREATE_FIELDS), createdAt: at, updatedAt: at });
    state.tasks[t.id] = t;
    state.nextId = Math.max(state.nextId, t.id + 1);
    log(t.origin === 'agent' && !t.approved ? 'suggested' : 'created', t.id, t.title);
    return state;
  }
  if (ev.type === 'message.posted') return applyMessage(state, d.message, ev.seq, at, log);

  const task = taskAt(state, d.id);
  if (!task) return state;
  switch (ev.type) {
    case 'task.updated':
      Object.assign(task, pick(isObj(d.changes) ? d.changes : {}, EDITABLE));
      break;
    case 'task.approved':
      task.approved = d.approved === true;
      if (task.approved) log('approved', task.id, task.title);
      break;
    case 'task.claimed':
      if (!isStr(d.agent)) return state;
      task.assignee = d.agent;
      task.assigneeName = displayName(d.agentName) ?? null;
      task.claim = { folder: strOrNull(d.folder), since: at };
      log('claimed', task.id, task.title);
      break;
    case 'task.released':
      task.assignee = null;
      task.assigneeName = null;
      task.claim = null;
      log(d.reason === 'folder-missing' || d.reason === 'timeout' ? 'auto-released' : 'released', task.id, task.title);
      break;
    case 'task.completed':
      Object.assign(task, {
        done: true, doneAt: at, completedBy: actor, completedByName: displayName(d.completedByName) ?? null,
        summary: strOrNull(d.summary), assignee: null, assigneeName: null, claim: null, openQuestions: [],
      });
      log('completed', task.id, task.title);
      break;
    case 'task.checklist': {
      if (!Array.isArray(d.items)) return state;
      const before = new Set(task.checklist.filter((i) => i.done).map((i) => i.text));
      task.checklist = d.items.filter((i) => isObj(i) && isStr(i.text)).map((i) => ({ text: i.text, done: !!i.done }));
      for (const i of task.checklist) if (i.done && !before.has(i.text)) log('checked', task.id, i.text);
      break;
    }
    case 'task.file':
      if (!isStr(d.path) || task.files.length >= FILES_LIMIT || task.files.some((f) => f.path === d.path)) return state;
      task.files.push({ path: d.path, by: strOrNull(d.by), at });
      break;
    default:
      return state; // forward compatible: unknown types change nothing
  }
  task.updatedAt = at;
  return state;
}

function applyMessage(state, m, seq, at, log) {
  if (!isObj(m) || !isStr(m.id) || !isStr(m.kind)) return state;
  const task = taskAt(state, m.taskId);
  if (!task) return state;
  task.messageCount += 1;
  task.updatedAt = at;
  const author = strOrNull(m.author);
  const authorName = displayName(m.authorName) ?? null;
  const holder = isStr(task.assignee) && task.assignee !== '' ? task.assignee : null;
  const to = isStr(m.to) ? m.to : m.kind === 'question' ? 'any' : null;
  const replyTo = strOrNull(m.replyTo);
  let replyToAuthor = null;
  if (m.kind === 'question') {
    task.openQuestions.push({ id: m.id, to, author, authorName, at, text: snippet(m.text) });
  }
  if (m.kind === 'answer' && replyTo) {
    const q = task.openQuestions.find((x) => x.id === replyTo);
    replyToAuthor = q ? q.author : null;
    task.openQuestions = task.openQuestions.filter((x) => x.id !== replyTo);
  }
  if (m.kind === 'handoff' || m.kind === 'summary') {
    task.lastHandoff = { author, at, kind: m.kind, text: snippet(m.text) };
  }
  if (m.kind === 'system' && m.closesQuestions) task.openQuestions = [];
  const about = strOrNull(m.about);
  push(
    state.messages,
    {
      id: m.id, seq, taskId: task.id, author, authorName, kind: m.kind, to, replyTo, replyToAuthor,
      mentions: Array.isArray(m.mentions) ? m.mentions.filter(isId) : [], relayedFromHuman: m.relayedFromHuman === true, about,
      holder, at, text: snippet(m.text),
    },
    MESSAGE_RING,
  );
  // a system note with an `about` is its own activity kind: 'unblocked', 'dependencies-done' (ops.completeTask)
  const activity = m.kind === 'question' ? 'question' : m.kind === 'answer' ? 'answer' : m.kind === 'system' ? about : null;
  if (activity) log(activity, task.id, m.text);
  return state;
}
