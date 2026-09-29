/**
 * @typedef {{ text: string, done: boolean }} ChecklistItem
 * @typedef {{ id: string, to: string, author: string, at: number, text: string }} OpenQuestion
 * @typedef {{
 *   id: number, kind: 'task' | 'epic', title: string, description: string, parent: number | null,
 *   labels: string[], dependsOn: number[], origin: 'human' | 'agent', createdBy: string, approved: boolean,
 *   rank: number, assignee: string | null, claim: { folder: string | null, since: number } | null,
 *   done: boolean, doneAt: number | null, completedBy: string | null, summary: string | null,
 *   checklist: ChecklistItem[], files: { path: string, by: string | null, at: number }[], filesMore: number,
 *   links: { title: string, target: string }[], openQuestions: OpenQuestion[],
 *   lastHandoff: { author: string, at: number, kind: string, text: string } | null,
 *   messageCount: number, createdAt: number, updatedAt: number
 * }} Task
 * @typedef {{ seq: number, at: number, type: string, taskId: number, actor: string, text: string }} Activity
 * @typedef {{ id: string, taskId: number, author: string, kind: string, to: string | null, replyTo: string | null,
 *   replyToAuthor: string | null, mentions: number[], relayedFromHuman: boolean, about: string | null,
 *   at: number, text: string }} MessageHeader
 * @typedef {{ schema: number, seq: number, nextId: number, eventsSize: number,
 *   tasks: Record<number, Task>, recent: Activity[], messages: MessageHeader[] }} BoardState
 * @typedef {{ seq: number, at: number, type: string, actor: string, data: any }} BoardEvent
 */

export const SCHEMA = 1;
export const RECENT_LIMIT = 500;
export const MESSAGE_RING = 300;
/** Files listed per task; later first touches only count up `filesMore`. */
export const FILES_LIMIT = 200;
const SNIPPET = 280;
/** The only fields task.updated may change; everything else follows from other events. */
const EDITABLE = ['title', 'description', 'parent', 'labels', 'dependsOn', 'rank', 'links'];
/** Task fields that must always be arrays, whatever the log says. */
const LISTS = new Set(['labels', 'dependsOn', 'links', 'checklist', 'files', 'openQuestions']);
const COUNTERS = ['messageCount', 'filesMore'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** An existing task by numeric id; never matches inherited keys ("__proto__") or strings ("1"). */
const taskAt = (state, id) => (Number.isSafeInteger(id) && Object.hasOwn(state.tasks, id) ? state.tasks[id] : undefined);

/** @returns {BoardState} */
export function emptyState() {
  return { schema: SCHEMA, seq: 0, nextId: 1, eventsSize: 0, tasks: {}, recent: [], messages: [] };
}

/** True for anything shaped like a log event: a plain object with a string type and a seq of 1 or more. */
export function isEvent(ev) {
  return isObj(ev) && typeof ev.type === 'string' && Number.isSafeInteger(ev.seq) && ev.seq >= 1;
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

/** @param {Partial<Task>} fields @returns {Task} */
export function newTask(fields) {
  /** @type {any} */
  const t = {
    id: 0, kind: 'task', title: '', description: '', parent: null, labels: [], dependsOn: [],
    origin: 'human', createdBy: 'human', approved: true, rank: 0,
    assignee: null, claim: null, done: false, doneAt: null, completedBy: null, summary: null,
    checklist: [], files: [], filesMore: 0, links: [], openQuestions: [], lastHandoff: null, messageCount: 0,
    createdAt: 0, updatedAt: 0,
    ...fields,
  };
  for (const k of LISTS) if (!Array.isArray(t[k])) t[k] = [];
  for (const k of COUNTERS) if (!Number.isSafeInteger(t[k]) || t[k] < 0) t[k] = 0;
  return t;
}
const TASK_FIELDS = Object.keys(newTask({}));

function push(ring, item, limit) {
  ring.push(item);
  if (ring.length > limit) ring.splice(0, ring.length - limit);
}

/**
 * Applies one event. Tolerant by design: anything malformed (not an event, missing or wrong-typed
 * data, unknown task) changes nothing, and nothing stored is `undefined`, so a snapshot and a replay
 * of the log always agree.
 * @param {BoardState} state @param {BoardEvent} ev @returns {BoardState}
 */
export function applyEvent(state, ev) {
  if (!isEvent(ev)) return state;
  if (ev.seq > state.seq) state.seq = ev.seq;
  const d = isObj(ev.data) ? ev.data : {};
  const at = ev.at ?? null;
  const actor = ev.actor ?? null;
  const log = (type, taskId, text) =>
    push(state.recent, { seq: ev.seq, at, type, taskId, actor, text: snippet(text) }, RECENT_LIMIT);

  if (ev.type === 'task.created') {
    const src = d.task;
    if (!isObj(src) || !Number.isSafeInteger(src.id) || src.id < 1 || Object.hasOwn(state.tasks, src.id)) return state;
    /** @type {Record<string, any>} */
    const fields = {};
    for (const k of TASK_FIELDS) if (Object.hasOwn(src, k) && src[k] !== undefined) fields[k] = src[k];
    const t = newTask({ ...fields, createdAt: at, updatedAt: at });
    state.tasks[t.id] = t;
    state.nextId = Math.max(state.nextId, t.id + 1);
    log(t.origin === 'agent' && !t.approved ? 'suggested' : 'created', t.id, t.title);
    return state;
  }
  if (ev.type === 'message.posted') return applyMessage(state, d.message, at, log);

  const task = taskAt(state, d.id);
  if (!task) return state;
  switch (ev.type) {
    case 'task.updated': {
      const changes = isObj(d.changes) ? d.changes : {};
      for (const k of EDITABLE) {
        if (!Object.hasOwn(changes, k) || changes[k] === undefined) continue;
        if (LISTS.has(k) && !Array.isArray(changes[k])) continue;
        task[k] = changes[k];
      }
      break;
    }
    case 'task.approved':
      task.approved = d.approved === true;
      if (task.approved) log('approved', task.id, task.title);
      break;
    case 'task.claimed':
      if (typeof d.agent !== 'string') return state;
      task.assignee = d.agent;
      task.claim = { folder: typeof d.folder === 'string' ? d.folder : null, since: at };
      log('claimed', task.id, task.title);
      break;
    case 'task.released':
      task.assignee = null;
      task.claim = null;
      log(d.reason === 'folder-missing' || d.reason === 'timeout' ? 'auto-released' : 'released', task.id, task.title);
      break;
    case 'task.completed':
      Object.assign(task, {
        done: true, doneAt: at, completedBy: actor, summary: typeof d.summary === 'string' ? d.summary : null,
        assignee: null, claim: null, openQuestions: [],
      });
      log('completed', task.id, task.title);
      break;
    case 'task.checklist': {
      if (!Array.isArray(d.items)) return state;
      const before = new Set(task.checklist.filter((i) => i.done).map((i) => i.text));
      task.checklist = d.items.filter((i) => isObj(i) && typeof i.text === 'string').map((i) => ({ text: i.text, done: !!i.done }));
      for (const i of task.checklist) if (i.done && !before.has(i.text)) log('checked', task.id, i.text);
      break;
    }
    case 'task.file':
      if (typeof d.path !== 'string') return state;
      if (task.files.some((f) => f.path === d.path)) break;
      if (task.files.length < FILES_LIMIT) task.files.push({ path: d.path, by: typeof d.by === 'string' ? d.by : null, at });
      else task.filesMore = (Number.isSafeInteger(task.filesMore) ? task.filesMore : 0) + 1;
      break;
    default:
      return state; // forward compatible: unknown types change nothing
  }
  task.updatedAt = at;
  return state;
}

function applyMessage(state, m, at, log) {
  if (!isObj(m)) return state;
  const task = taskAt(state, m.taskId);
  if (!task) return state;
  task.messageCount += 1;
  task.updatedAt = at;
  const id = m.id ?? null;
  const author = m.author ?? null;
  const to = m.to ?? (m.kind === 'question' ? 'any' : null);
  let replyToAuthor = null;
  if (m.kind === 'question') {
    task.openQuestions.push({ id, to, author, at, text: snippet(m.text) });
  }
  if (m.kind === 'answer' && m.replyTo) {
    const q = task.openQuestions.find((x) => x.id === m.replyTo);
    replyToAuthor = q ? q.author : null;
    task.openQuestions = task.openQuestions.filter((x) => x.id !== m.replyTo);
  }
  if (m.kind === 'handoff' || m.kind === 'summary') {
    task.lastHandoff = { author, at, kind: m.kind, text: snippet(m.text) };
  }
  if (m.kind === 'system' && m.closesQuestions) task.openQuestions = [];
  const about = typeof m.about === 'string' ? m.about : null;
  push(
    state.messages,
    {
      id, taskId: task.id, author, kind: m.kind ?? null, to, replyTo: m.replyTo ?? null,
      replyToAuthor, mentions: Array.isArray(m.mentions) ? m.mentions : [], relayedFromHuman: !!m.relayedFromHuman, about,
      at, text: snippet(m.text),
    },
    MESSAGE_RING,
  );
  const activity = m.kind === 'question' ? 'question' : m.kind === 'answer' ? 'answer' : m.kind === 'system' ? about : null;
  if (activity) log(activity, task.id, m.text);
  return state;
}
