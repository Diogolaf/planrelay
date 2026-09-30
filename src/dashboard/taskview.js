import { getAgent, nameOf, statusOf } from '../core/agents.js';
import { COLUMN_LABELS, columnOf } from '../core/derive.js';
import { getTask } from '../core/queries.js';
import { FILES_LIMIT, RECENT_LIMIT } from '../core/reduce.js';
import { colorOf, SHOWN_ACTIVITY, withDeadEnded } from './view.js';

/**
 * The dashboard's task view model (§13 Task view): what one task's page renders, as one JSON-ready
 * object (the data contract of the task view, TaskView).
 *
 * - Pure: no IO and no clock. The server passes the state, the registry, the config, `now`, the
 *   task's messages (readMessages), plus `host` and `alive` for withDeadEnded.
 * - Results share no objects with the state, the registry or the messages.
 * - Names (§4), as in view.js: built on getTask, so the holder shows the registry's name, then the
 *   name stored with the claim; history (creator, message authors, completer) shows the name
 *   stored with the event first; "an earlier agent" when no name is known. Avatar colors come from
 *   the registry, UNKNOWN_COLOR when it no longer knows the agent (view.js colorOf). A raw agent
 *   id is never used as a name; it only appears as `assignee.id`.
 * - The human's words: the task's creation when the human asked for it, and messages an agent
 *   relayed (relayedFromHuman), read as author "You" with `relayedBy` the relaying agent's name.
 *
 * @typedef {import('../core/reduce.js').BoardState} BoardState
 * @typedef {import('../core/store.js').Registry} Registry
 * @typedef {import('../core/config.js').Config} Config
 * @typedef {import('../core/derive.js').Column} Column
 *
 * @typedef {{ id: number, title: string, column: Column | null }} TaskRef
 * @typedef {'CREATED' | 'COMMENT' | 'QUESTION → YOU' | 'QUESTION → ANYONE' | string} Tag
 *   also 'QUESTION → <NAME>' (the addressee's name in upper case), 'ANSWER', 'HANDOFF', 'SUMMARY', 'AUTOMATIC'
 * @typedef {{ id: string | null, tag: Tag, authorName: string, authorKind: 'human' | 'agent' | 'system',
 *   authorColor: string | null, at: number | null, text: string, relayedBy: string | null }} Entry
 *   authorColor: an agent's avatar color; null for the human and the system (the UI styles those)
 * @typedef {{
 *   id: number, title: string, kind: 'task' | 'epic', column: Column | null, columnLabel: string,
 *   status: { text: string, column: Column | null },
 *   breadcrumb: { id: number, title: string }[],
 *   assignee: { id: string, name: string, color: string, since: number | null, gone: boolean } | null,
 *   labels: string[], origin: string,
 *   question: { id: string, text: string, at: number | null, authorName: string, authorColor: string } | null,
 *   description: string,
 *   checklist: { items: { text: string, done: boolean }[], done: number, total: number },
 *   conversation: Entry[],
 *   details: { status: string, agent: string | null, epic: string | null, labels: string[], origin: string, createdAt: number | null },
 *   dependsOn: TaskRef[], blocks: TaskRef[],
 *   files: { path: string, agentName: string }[], filesMore: boolean,
 *   links: { title: string, target: string, href: string | null }[],
 *   timeline: { count: number, truncated: boolean },
 *   summary: string | null, completedByName: string | null, doneAt: number | null,
 * }} TaskView
 */

const SHOWN = new Set(SHOWN_ACTIVITY);
/** Link targets that get an href; anything else (a repository path) is shown as text. */
const WEB = /^https?:\/\//i;
/** Tags by message kind; a question's tag names its addressee, and an unknown kind reads as a comment. */
const TAGS = Object.freeze({ comment: 'COMMENT', answer: 'ANSWER', handoff: 'HANDOFF', summary: 'SUMMARY', system: 'AUTOMATIC' });

/** A task by id; never matches inherited keys. */
const taskOf = (tasks, id) => (Object.hasOwn(tasks, id) ? tasks[id] : undefined);

/** The ancestor epics of a task, outermost first: through epics only, at any depth, cycle-safe (like epicPath). */
function breadcrumbOf(t, tasks) {
  const out = [];
  const visited = new Set();
  let p = t.parent != null ? taskOf(tasks, t.parent) : undefined;
  while (p && p.kind === 'epic' && !visited.has(p)) {
    visited.add(p);
    out.unshift({ id: p.id, title: p.title });
    p = p.parent != null ? taskOf(tasks, p.parent) : undefined;
  }
  return out;
}

/**
 * Whether an agent's task began as a suggestion: one not approved yet, or made while agents'
 * tasks need approval (the config, which rarely changes). Epics never wait for approval.
 */
const wasSuggested = (t, cfg) => t.kind === 'task' && (!t.approved || cfg.agentTasksNeedApproval !== false);

/** The status pill: the column label with its reason ("Blocked · waiting on you"); "Epic" for an epic. */
function statusText(t, reg) {
  if (t.column === null) return 'Epic';
  const label = COLUMN_LABELS[t.column];
  if (t.column === 'backlog') return t.origin === 'agent' && !t.approved ? `${label} · suggested` : label;
  if (t.column !== 'blocked') return label;
  if (t.blockers.some((b) => b.type === 'question' && b.to === 'human')) return `${label} · waiting on you`;
  const [b] = t.blockers;
  if (!b) return label;
  if (b.type === 'dependency') return `${label} · waiting on #${b.id}`;
  if (b.to === 'any') return `${label} · question to any agent`;
  return `${label} · question to ${nameOf(reg, b.to)}`;
}

/** A message's tag (see TAGS). */
function tagOf(m, reg) {
  if (m.kind !== 'question') return Object.hasOwn(TAGS, m.kind) ? TAGS[m.kind] : TAGS.comment;
  if (m.to === 'human') return 'QUESTION → YOU';
  if (m.to == null || m.to === 'any') return 'QUESTION → ANYONE';
  return `QUESTION → ${nameOf(reg, m.to).toUpperCase()}`;
}

/** A conversation entry for one message of getTask (authorName already resolved). @returns {Entry} */
function entryOf(m, reg) {
  const system = m.kind === 'system';
  const relayed = !system && m.relayedFromHuman === true;
  return {
    id: typeof m.id === 'string' ? m.id : null,
    tag: tagOf(m, reg),
    authorName: system ? 'System' : relayed ? 'You' : m.authorName,
    authorKind: system ? 'system' : relayed ? 'human' : 'agent',
    authorColor: system || relayed ? null : colorOf(reg, m.author),
    at: Number.isFinite(m.at) ? m.at : null,
    text: typeof m.text === 'string' ? m.text : '',
    relayedBy: relayed ? m.authorName : null,
  };
}

/** A task as a dependency row. @returns {TaskRef} */
const refOf = (o, tasks) => ({ id: o.id, title: o.title, column: columnOf(o, tasks) });

/**
 * The view model of one task's page (see TaskView), or null when no task has this number.
 * - status: the column label with its reason: for Blocked, the human's answer first ("waiting on
 *   you"), else the first blocker ("waiting on #12", "question to Jade", "question to any agent");
 *   for Backlog, " · suggested" on an agent's suggestion.
 * - assignee: the current holder; since: when it claimed the task; gone: its session has ended
 *   (or its process is gone, withDeadEnded) or the registry no longer knows it.
 * - origin: "requested by you" (the human asked for it), "suggested by Amber" (an agent's task that
 *   is or was a suggestion, see wasSuggested), else "created by Amber"; details.origin capitalized.
 * - question: the first open question to the human, with the full text from the message file
 *   when it is there, else the stored snippet.
 * - conversation: the creation first (CREATED, at createdAt), then the messages, oldest first.
 * - timeline: the task's entries in the activity ring that the Activity feed shows (decision 7);
 *   truncated when the ring is full and no longer holds the task's creation.
 * @param {{ state: BoardState, reg: Registry, cfg: Config, now: number, id: unknown, messages?: unknown,
 *   host: string | null, alive: (pid: number) => boolean }} input
 *   id: a task number (anything else is refused with getTask's BoardError); messages: from readMessages
 * @returns {TaskView | null}
 */
export function buildTaskView({ state, reg: stored, cfg, now, id, messages = [], host, alive }) {
  const reg = withDeadEnded(stored, { host, alive, now, cfg });
  const t = getTask(state, reg, id, messages);
  if (!t) return null;
  const { tasks } = state;
  const columnLabel = t.column === null ? 'Epic' : COLUMN_LABELS[t.column];
  const breadcrumb = breadcrumbOf(t, tasks);

  const held = typeof t.assignee === 'string' && t.assignee !== '';
  const assignee = held ? {
    id: /** @type {string} */ (t.assignee),
    name: /** @type {string} */ (t.assigneeName),
    color: colorOf(reg, t.assignee),
    since: t.claim && Number.isFinite(t.claim.since) ? t.claim.since : null,
    gone: statusOf(getAgent(reg, t.assignee), now, cfg) === 'gone',
  } : null;

  const byHuman = t.origin !== 'agent';
  const verb = byHuman ? 'requested' : wasSuggested(t, cfg) ? 'suggested' : 'created';
  const origin = byHuman ? 'requested by you' : `${verb} by ${t.createdByName}`;

  const asked = t.openQuestions.find((q) => q.to === 'human');
  const full = asked && t.messages.find((m) => m.kind === 'question' && m.id === asked.id);
  const question = asked ? {
    id: asked.id,
    text: full && typeof full.text === 'string' ? full.text : asked.text,
    at: asked.at,
    authorName: asked.authorName,
    authorColor: colorOf(reg, asked.author),
  } : null;

  const parentEpic = breadcrumb.at(-1);
  /** @type {Entry} */
  const creation = {
    id: 'created',
    tag: 'CREATED',
    authorName: byHuman ? 'You' : t.createdByName,
    authorKind: byHuman ? 'human' : 'agent',
    authorColor: byHuman ? null : colorOf(reg, t.createdBy),
    at: t.createdAt,
    text: `${verb[0].toUpperCase()}${verb.slice(1)} the ${t.kind === 'epic' ? 'epic' : 'task'}${parentEpic ? ` and put it in the ${parentEpic.title} epic` : ''}.`,
    relayedBy: byHuman ? t.requestedViaName : null,
  };

  const inRing = state.recent.filter((e) => e.taskId === t.id);
  return {
    id: t.id,
    title: t.title,
    kind: t.kind,
    column: t.column,
    columnLabel,
    status: { text: statusText(t, reg), column: t.column },
    breadcrumb,
    assignee,
    labels: [...t.labels],
    origin,
    question,
    description: t.description,
    checklist: {
      items: t.checklist.map((i) => ({ text: i.text, done: i.done })),
      done: t.checklist.filter((i) => i.done).length,
      total: t.checklist.length,
    },
    conversation: [creation, ...t.messages.map((m) => entryOf(m, reg))],
    details: {
      status: columnLabel,
      agent: assignee ? assignee.name : null,
      epic: t.epicPath || null,
      labels: [...t.labels],
      origin: `${origin[0].toUpperCase()}${origin.slice(1)}`,
      createdAt: t.createdAt,
    },
    dependsOn: t.dependsOn.map((d) => taskOf(tasks, d)).filter((d) => d !== undefined).map((d) => refOf(d, tasks)),
    blocks: t.blocks.map((b) => refOf(tasks[b], tasks)),
    files: t.files.map((f) => ({ path: f.path, agentName: nameOf(reg, f.by) })),
    filesMore: t.files.length >= FILES_LIMIT,
    links: t.links.map((l) => ({ title: l.title, target: l.target, href: WEB.test(l.target) ? l.target : null })),
    timeline: {
      count: inRing.filter((e) => SHOWN.has(e.type)).length,
      truncated: state.recent.length >= RECENT_LIMIT && !inRing.some((e) => e.type === 'created' || e.type === 'suggested'),
    },
    summary: t.summary,
    completedByName: t.completedByName,
    doneAt: t.doneAt,
  };
}
