/**
 * @typedef {{ text: string, done: boolean }} ChecklistItem
 * @typedef {{ id: string, to: string, author: string, at: number, text: string }} OpenQuestion
 * @typedef {{
 *   id: number, kind: 'task' | 'epic', title: string, description: string, parent: number | null,
 *   labels: string[], dependsOn: number[], origin: 'human' | 'agent', createdBy: string, approved: boolean,
 *   rank: number, assignee: string | null, claim: { folder: string | null, since: number } | null,
 *   done: boolean, doneAt: number | null, completedBy: string | null, summary: string | null,
 *   checklist: ChecklistItem[], files: { path: string, by: string, at: number }[],
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
const SNIPPET = 280;

/** @returns {BoardState} */
export function emptyState() {
  return { schema: SCHEMA, seq: 0, nextId: 1, eventsSize: 0, tasks: {}, recent: [], messages: [] };
}

/** One-line, bounded version of a text for rings and pings. */
export function snippet(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > SNIPPET ? `${t.slice(0, SNIPPET - 1)}…` : t;
}

/** @param {Partial<Task>} fields @returns {Task} */
export function newTask(fields) {
  return {
    id: 0, kind: 'task', title: '', description: '', parent: null, labels: [], dependsOn: [],
    origin: 'human', createdBy: 'human', approved: true, rank: 0,
    assignee: null, claim: null, done: false, doneAt: null, completedBy: null, summary: null,
    checklist: [], files: [], links: [], openQuestions: [], lastHandoff: null, messageCount: 0,
    createdAt: 0, updatedAt: 0,
    ...fields,
  };
}

function push(ring, item, limit) {
  ring.push(item);
  if (ring.length > limit) ring.splice(0, ring.length - limit);
}

/** @param {BoardState} state @param {BoardEvent} ev @returns {BoardState} */
export function applyEvent(state, ev) {
  const d = ev.data || {};
  const log = (type, taskId, text) =>
    push(state.recent, { seq: ev.seq, at: ev.at, type, taskId, actor: ev.actor, text: snippet(text) }, RECENT_LIMIT);
  state.seq = ev.seq;

  if (ev.type === 'task.created') {
    const t = newTask({ ...d.task, createdAt: ev.at, updatedAt: ev.at });
    state.tasks[t.id] = t;
    state.nextId = Math.max(state.nextId, t.id + 1);
    log(t.origin === 'agent' && !t.approved ? 'suggested' : 'created', t.id, t.title);
    return state;
  }
  if (ev.type === 'message.posted') return applyMessage(state, ev, log);

  const task = typeof d.id === 'number' ? state.tasks[d.id] : undefined;
  if (!task) return state;
  switch (ev.type) {
    case 'task.updated':
      Object.assign(task, d.changes);
      break;
    case 'task.approved':
      task.approved = !!d.approved;
      if (task.approved) log('approved', task.id, task.title);
      break;
    case 'task.claimed':
      task.assignee = d.agent;
      task.claim = { folder: d.folder ?? null, since: ev.at };
      log('claimed', task.id, task.title);
      break;
    case 'task.released':
      task.assignee = null;
      task.claim = null;
      log(d.reason === 'manual' ? 'released' : 'auto-released', task.id, task.title);
      break;
    case 'task.completed':
      Object.assign(task, {
        done: true, doneAt: ev.at, completedBy: ev.actor, summary: d.summary, assignee: null, claim: null, openQuestions: [],
      });
      log('completed', task.id, task.title);
      break;
    case 'task.checklist': {
      const before = new Set(task.checklist.filter((i) => i.done).map((i) => i.text));
      task.checklist = d.items.map((i) => ({ text: String(i.text), done: !!i.done }));
      for (const i of task.checklist) if (i.done && !before.has(i.text)) log('checked', task.id, i.text);
      break;
    }
    case 'task.file':
      if (!task.files.some((f) => f.path === d.path)) task.files.push({ path: d.path, by: d.by, at: ev.at });
      break;
    default:
      return state; // forward compatible: unknown types change nothing
  }
  task.updatedAt = ev.at;
  return state;
}

function applyMessage(state, ev, log) {
  const m = ev.data.message;
  const task = state.tasks[m.taskId];
  if (!task) return state;
  task.messageCount += 1;
  task.updatedAt = ev.at;
  let replyToAuthor = null;
  if (m.kind === 'question') {
    task.openQuestions.push({ id: m.id, to: m.to ?? 'any', author: m.author, at: ev.at, text: snippet(m.text) });
  }
  if (m.kind === 'answer' && m.replyTo) {
    const q = task.openQuestions.find((x) => x.id === m.replyTo);
    replyToAuthor = q ? q.author : null;
    task.openQuestions = task.openQuestions.filter((x) => x.id !== m.replyTo);
  }
  if (m.kind === 'handoff' || m.kind === 'summary') {
    task.lastHandoff = { author: m.author, at: ev.at, kind: m.kind, text: m.text };
  }
  if (m.kind === 'system' && m.closesQuestions) task.openQuestions = [];
  push(
    state.messages,
    {
      id: m.id, taskId: m.taskId, author: m.author, kind: m.kind, to: m.to ?? null, replyTo: m.replyTo ?? null,
      replyToAuthor, mentions: m.mentions ?? [], relayedFromHuman: !!m.relayedFromHuman, about: m.about ?? null,
      at: ev.at, text: snippet(m.text),
    },
    MESSAGE_RING,
  );
  const activity = m.kind === 'question' ? 'question' : m.kind === 'answer' ? 'answer' : m.kind === 'system' ? m.about ?? null : null;
  if (activity) log(activity, m.taskId, m.text);
  return state;
}
