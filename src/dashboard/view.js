import { getAgent, nameOf, statusOf } from '../core/agents.js';
import { blockers, byRank, childrenIndex, columnOf, COLUMNS, epicPath, epicProgress, readyQueue } from '../core/derive.js';
import { lastActivity } from '../core/maintenance.js';
import { claimedBy } from '../core/ops.js';
import { boardCounts, needsHuman } from '../core/queries.js';
import { displayName } from '../core/reduce.js';

/**
 * The dashboard's view model (§13): what the Overview, the Board, the Activity feed and the header
 * render, as one JSON-ready object (the data contract of the UI views).
 *
 * - Pure: no IO and no clock. The server passes the state, the registry, the config, `now` and
 *   local midnight, plus `host` and `alive` for withDeadEnded.
 * - Results share no objects with the state or the registry.
 * - Names (§4), as in queries.js: a task's current holder shows the registry's name, then the name
 *   stored with the claim; history (suggested by, completed by, activity) shows the name stored
 *   with the event first. "an earlier agent" when no name is known. A raw agent id is never used as
 *   a name; it only appears as an `id`, for filtering.
 *
 * @typedef {import('../core/reduce.js').BoardState} BoardState
 * @typedef {import('../core/reduce.js').Task} Task
 * @typedef {import('../core/store.js').Registry} Registry
 * @typedef {import('../core/config.js').Config} Config
 * @typedef {import('../core/derive.js').Column} Column
 *
 * @typedef {{ done: number, total: number }} Progress
 * @typedef {{ kind: 'dependency', id: number } | { kind: 'human' } | { kind: 'agent', name: string } | { kind: 'any' }} Blocker
 * @typedef {{ kind: 'origin', suggestedBy: string | null } | { kind: 'queue', position: number }
 *   | { kind: 'progress', checklist: Progress | null, lastActivityAt: number | null }
 *   | { kind: 'waits', id: number, backTo: 'In progress' | 'Ready' } | { kind: 'done', at: number | null }} Meta
 * @typedef {{ id: string, name: string, color: string, initial: string, status: 'active' | 'idle',
 *   pill: 'In progress' | 'Blocked' | 'Idle' | 'No task', task: { id: number, title: string } | null,
 *   checklist: Progress | null, lastFile: string | null, blockedReason: string | null, lastActivityAt: number | null }} AgentCard
 * @typedef {{ id: number, title: string, column: Column, suggested: boolean, labels: string[], firstLabel: string | null,
 *   epicPath: string, epicIds: number[], assignee: { id: string, name: string, color: string } | null,
 *   completer: { id: string | null, name: string, color: string } | null, stalled: { since: number } | null, blockers: Blocker[], meta: Meta | null, rank: number, doneAt: number | null,
 *   updatedAt: number | null }} Card
 * @typedef {{
 *   project: string, now: number, seq: number, badLines: number, activeCount: number, agents: AgentCard[],
 *   needsYou: {
 *     count: number,
 *     questions: { kind: 'question', taskId: number, title: string, questionId: string, text: string, askedBy: string, at: number | null }[],
 *     approvals: { kind: 'approve', ids: number[], items: { id: number, title: string, suggestedBy: string }[] } | null,
 *     stalled: { kind: 'stalled', id: number, title: string, holderName: string, since: number, releaseAt: number }[],
 *   },
 *   shippedToday: { id: number, title: string, agentName: string, doneAt: number, summary: string | null }[],
 *   epics: { id: number, title: string, depth: 0 | 1, parent: number | null, done: number, total: number }[],
 *   counts: Record<Column | 'suggested', number>,
 *   nextInLine: { position: number, id: number, title: string, epicPath: string }[],
 *   labels: { name: string, count: number }[],
 *   cards: Card[],
 *   activity: { seq: number, at: number | null, type: string, taskId: number, taskTitle: string | null, actorName: string, text: string }[],
 * }} View
 */

/** Activity kinds the feed shows (§13 Activity); file edits are never logged as activity. */
export const SHOWN_ACTIVITY = Object.freeze([
  'created', 'suggested', 'approved', 'claimed', 'checked', 'question', 'answer', 'completed', 'released',
  'unblocked', 'dependencies-done', 'auto-released',
]);
const SHOWN = new Set(SHOWN_ACTIVITY);

/** The avatar color of an agent the registry no longer knows: a warm gray under white initials at 4.5:1 or more. */
export const UNKNOWN_COLOR = '#5F5C55';
/** The name of an agent nobody recorded a name for. */
const UNKNOWN = 'an earlier agent';

/** A task by id; never matches inherited keys. */
const taskOf = (tasks, id) => (Object.hasOwn(tasks, id) ? tasks[id] : undefined);

/** A task's current holder: the registry's name, then the name stored with the claim. */
const holderName = (reg, t) => displayName(getAgent(reg, t.assignee)?.name) ?? displayName(t.assigneeName) ?? UNKNOWN;

/** A history name: the one stored with the event, else the registry's (nameOf: "system", "an earlier agent"). */
const writtenBy = (reg, id, name) => displayName(name) ?? nameOf(reg, id);

/**
 * An agent's avatar color from the registry, UNKNOWN_COLOR when the registry does not know it.
 * @param {Registry} reg @param {unknown} id @returns {string}
 */
export function colorOf(reg, id) {
  const color = getAgent(reg, id)?.color;
  return typeof color === 'string' ? color : UNKNOWN_COLOR;
}

/**
 * The Now card's file: the agent's last edited file, unless it was edited before its current claim
 * began (a previous task's file). Kept when a time is unknown, and when the agent holds no task.
 * @returns {string | null}
 */
function lastFileOf(a, task) {
  if (typeof a.lastFile !== 'string') return null;
  const since = task?.claim?.since;
  return Number.isFinite(since) && Number.isFinite(a.lastFileAt) && a.lastFileAt < since ? null : a.lastFile;
}

/** Arrival time for the Now order; agents without a usable one come last. */
const arrival = (a) => (Number.isFinite(a.firstSeen) ? a.firstSeen : Infinity);

/** Checklist progress, null when the task has no checklist. @returns {Progress | null} */
function checklistOf(t) {
  if (t.checklist.length === 0) return null;
  return { done: t.checklist.filter((i) => i.done).length, total: t.checklist.length };
}

/**
 * What blocks a task, as card chips: open dependencies, then open questions by addressee (the
 * human, a named agent, any agent). Identical chips are shown once.
 * @param {Task} t @param {Record<number, Task>} tasks @param {Registry} reg @returns {Blocker[]}
 */
function blockerChips(t, tasks, reg) {
  /** @type {Blocker[]} */
  const out = [];
  const seen = new Set();
  for (const b of blockers(t, tasks)) {
    /** @type {Blocker} */
    let chip;
    if (b.type === 'dependency') chip = { kind: 'dependency', id: b.id };
    else if (b.to === 'human') chip = { kind: 'human' };
    else if (b.to === 'any') chip = { kind: 'any' };
    else chip = { kind: 'agent', name: displayName(getAgent(reg, b.to)?.name) ?? UNKNOWN };
    const key = JSON.stringify(chip);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(chip);
  }
  return out;
}

/** The Now card's blocking reason: the human's answer first, else the first chip. */
function blockedReason(chips) {
  if (chips.some((b) => b.kind === 'human')) return 'Waiting for your answer';
  const [b] = chips;
  if (!b) return null;
  if (b.kind === 'dependency') return `Waiting on #${b.id}`;
  if (b.kind === 'any') return 'Waiting for any agent';
  return `Waiting for ${/** @type {{ name: string }} */ (b).name}`;
}

/** The ancestor epics of a task, nearest first: through epics only, at most 2 levels (epics nest once), cycle-safe. */
function epicIdsOf(t, tasks) {
  const ids = [];
  let p = t.parent != null ? taskOf(tasks, t.parent) : undefined;
  while (p && p.kind === 'epic' && ids.length < 2 && !ids.includes(p.id)) {
    ids.push(p.id);
    p = p.parent != null ? taskOf(tasks, p.parent) : undefined;
  }
  return ids;
}

/** Completion time for sorting Done, newest first; -Infinity when not usable, so those come last. */
const doneTime = (t) => (Number.isFinite(t.doneAt) ? t.doneAt : -Infinity);

/** Code-unit order, the same on every machine (no locale). */
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The registry as the dashboard sees it: a live agent counts as ended now when housekeeping would
 * end it at its next write (§10, maintenance.js): its process on this host no longer exists, or it
 * has not been seen for claimTimeoutHours (lastSeen, else firstSeen; on any host). Returns a copy;
 * `reg` is not changed (agents that stay live are shared with it, so treat the copy as read-only).
 * @param {Registry} reg
 * @param {{ host: string | null, alive: (pid: number) => boolean, now: number, cfg: Config }} io
 * @returns {Registry}
 */
export function withDeadEnded(reg, { host, alive, now, cfg }) {
  const timeoutMs = cfg.claimTimeoutHours * 3_600_000;
  const agents = Object.fromEntries(Object.entries(reg.agents).map(([id, a]) => {
    if (a.endedAt != null) return [id, a];
    const deadHere = host != null && a.host === host && Number.isInteger(a.pid) && a.pid > 0 && !alive(a.pid);
    const seen = [a.lastSeen, a.firstSeen].find(Number.isFinite) ?? -Infinity;
    return [id, deadHere || !(now - seen <= timeoutMs) ? { ...a, endedAt: now } : a];
  }));
  return { ...reg, agents };
}

/**
 * The view model of the Overview, the Board, the Activity feed and the header (see View).
 * - agents: live agents (not ended in the effective registry), in order of arrival (firstSeen,
 *   oldest first; the id breaks ties), so cards keep their places as hooks refresh lastSeen.
 *   lastFile: see lastFileOf.
 * - needsYou: questions to the human, suggestions to approve (one grouped row), stalled claims (needsHuman).
 * - shippedToday: done at or after `midnight`, newest first.
 * - epics: top-level epics by rank, each followed by its sub-epics by rank; an epic whose parent
 *   is not an existing epic counts as top level.
 * - cards: every task (not epics), in board order: column, then rank; Done newest first.
 *   Meta: Backlog, who suggested it (null: created by the human); Ready, the queue position;
 *   In progress, the checklist and last activity; Blocked, the first open dependency ("back to …
 *   when #N closes"), else the holder's progress, else null; Done, the completion time. A stalled
 *   card's progress leaves out the time: its "No agent for …" chip already shows it.
 *   assignee: the current holder (agent filters follow it); completer: on Done cards only, who
 *   completed the task (the stored name, then the registry's), for the card's avatar and the
 *   Board's agent swimlanes; its id is the agent's, null when the registry does not know it.
 * - activity: the activity ring, newest first (entries of one event keep their order), shown kinds only.
 * @param {{ state: BoardState, reg: Registry, cfg: Config, now: number, midnight: number, projectName: string,
 *   badLines: number, host: string | null, alive: (pid: number) => boolean }} input
 *   midnight: local midnight of `now`; host, alive: see withDeadEnded
 * @returns {View}
 */
export function buildView({ state, reg: stored, cfg, now, midnight, projectName, badLines, host, alive }) {
  const reg = withDeadEnded(stored, { host, alive, now, cfg });
  const { tasks } = state;
  const all = Object.values(tasks);
  const columns = new Map(all.map((t) => [t.id, columnOf(t, tasks)]));
  const chipsOf = (t) => (columns.get(t.id) === 'blocked' ? blockerChips(t, tasks, reg) : []);

  /** @type {AgentCard[]} */
  const agents = Object.entries(reg.agents)
    .filter(([, a]) => a.endedAt == null)
    .sort(([xId, x], [yId, y]) => arrival(x) - arrival(y) || byText(xId, yId))
    .map(([id, a]) => {
      const name = displayName(a.name) ?? UNKNOWN;
      const status = /** @type {'active' | 'idle'} */ (statusOf(a, now, cfg));
      const task = claimedBy(state, id);
      const blocked = task != null && columns.get(task.id) === 'blocked';
      return {
        id,
        name,
        color: typeof a.color === 'string' ? a.color : UNKNOWN_COLOR,
        initial: Array.from(name)[0].toUpperCase(),
        status,
        pill: status === 'idle' ? 'Idle' : !task ? 'No task' : blocked ? 'Blocked' : 'In progress',
        task: task ? { id: task.id, title: task.title } : null,
        checklist: task ? checklistOf(task) : null,
        lastFile: lastFileOf(a, task),
        blockedReason: blocked ? blockedReason(chipsOf(task)) : null,
        lastActivityAt: task ? lastActivity(task, reg) : Number.isFinite(a.lastSeen) ? a.lastSeen : null,
      };
    });

  const human = needsHuman(state, reg, cfg, now);
  const questions = human.questions.map((q) => ({
    kind: /** @type {const} */ ('question'), taskId: q.taskId, title: q.title, questionId: q.question.id, text: q.question.text,
    askedBy: q.askedBy, at: q.question.at,
  }));
  const approvals = human.approvals.length === 0 ? null : {
    kind: /** @type {const} */ ('approve'),
    ids: human.approvals.map((a) => a.id),
    items: human.approvals.map((a) => ({ id: a.id, title: a.title, suggestedBy: a.suggestedBy })),
  };
  const stalled = human.stalled.map((s) => ({
    kind: /** @type {const} */ ('stalled'), id: s.id, title: s.title, holderName: holderName(reg, tasks[s.id]), since: s.since, releaseAt: s.releaseAt,
  }));

  const shippedToday = all
    .filter((t) => t.kind === 'task' && t.done && Number.isFinite(t.doneAt) && t.doneAt >= midnight)
    .sort((a, b) => b.doneAt - a.doneAt || byRank(a, b))
    .map((t) => ({ id: t.id, title: t.title, agentName: writtenBy(reg, t.completedBy, t.completedByName), doneAt: t.doneAt, summary: t.summary }));

  const children = childrenIndex(tasks);
  const isEpic = (id) => id != null && taskOf(tasks, id)?.kind === 'epic';
  const epicRow = (e, depth, parent) => ({ id: e.id, title: e.title, depth, parent, ...epicProgress(e.id, tasks, children) });
  const epics = all
    .filter((e) => e.kind === 'epic' && !isEpic(e.parent))
    .sort(byRank)
    .flatMap((top) => [
      epicRow(top, 0, null),
      ...(children.get(top.id) ?? []).filter((e) => e.kind === 'epic').sort(byRank).map((sub) => epicRow(sub, 1, top.id)),
    ]);

  const queue = readyQueue(tasks);
  const position = new Map(queue.map((t, i) => [t.id, i + 1]));
  const nextInLine = queue.slice(0, 3).map((t, i) => ({ position: i + 1, id: t.id, title: t.title, epicPath: epicPath(t, tasks) }));

  const taskList = all.filter((t) => t.kind === 'task');
  /** @type {Map<string, number>} */
  const perLabel = new Map();
  for (const t of taskList) for (const name of new Set(t.labels)) perLabel.set(name, (perLabel.get(name) ?? 0) + 1);
  const labels = [...perLabel].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || byText(a.name, b.name));

  const order = (t) => COLUMNS.indexOf(/** @type {Column} */ (columns.get(t.id)));
  const cards = taskList
    .sort((a, b) => order(a) - order(b) || (columns.get(a.id) === 'done' ? doneTime(b) - doneTime(a) || byRank(a, b) : byRank(a, b)))
    .map((t) => {
      const column = /** @type {Column} */ (columns.get(t.id));
      const held = typeof t.assignee === 'string' && t.assignee !== '';
      const gone = held && !t.done && statusOf(getAgent(reg, t.assignee), now, cfg) === 'gone';
      const chips = chipsOf(t);
      /** @type {Meta} */
      const progress = { kind: 'progress', checklist: checklistOf(t), lastActivityAt: gone ? null : lastActivity(t, reg) };
      /** @type {Meta | null} */
      let meta = null;
      if (column === 'backlog') meta = { kind: 'origin', suggestedBy: t.origin === 'agent' ? writtenBy(reg, t.createdBy, t.createdByName) : null };
      else if (column === 'ready') meta = { kind: 'queue', position: /** @type {number} */ (position.get(t.id)) };
      else if (column === 'in_progress') meta = progress;
      else if (column === 'blocked') {
        const dep = /** @type {{ id: number } | undefined} */ (chips.find((b) => b.kind === 'dependency'));
        if (dep) meta = { kind: 'waits', id: dep.id, backTo: held ? 'In progress' : 'Ready' };
        else if (held) meta = progress;
      } else if (column === 'done') meta = { kind: 'done', at: t.doneAt };
      return {
        id: t.id,
        title: t.title,
        column,
        suggested: !t.approved && t.origin === 'agent',
        labels: [...t.labels],
        firstLabel: t.labels[0] ?? null,
        epicPath: epicPath(t, tasks),
        epicIds: epicIdsOf(t, tasks),
        assignee: held ? { id: /** @type {string} */ (t.assignee), name: holderName(reg, t), color: colorOf(reg, t.assignee) } : null,
        completer: column === 'done'
          ? {
            id: getAgent(reg, t.completedBy) ? /** @type {string} */ (t.completedBy) : null,
            name: writtenBy(reg, t.completedBy, t.completedByName),
            color: colorOf(reg, t.completedBy),
          }
          : null,
        stalled: gone ? { since: lastActivity(t, reg) } : null,
        blockers: chips,
        meta,
        rank: t.rank,
        doneAt: t.doneAt,
        updatedAt: t.updatedAt,
      };
    });

  // a stable sort: entries logged by one event share its seq and keep their order
  const activity = state.recent
    .filter((e) => SHOWN.has(e.type))
    .sort((a, b) => b.seq - a.seq)
    .map((e) => ({
      seq: e.seq, at: e.at, type: e.type, taskId: e.taskId, taskTitle: taskOf(tasks, e.taskId)?.title ?? null,
      actorName: writtenBy(reg, e.actor, e.actorName), text: e.text,
    }));

  return {
    project: projectName,
    now,
    seq: state.seq,
    badLines,
    activeCount: agents.filter((a) => a.status === 'active').length,
    agents,
    needsYou: { count: questions.length + (approvals ? 1 : 0) + stalled.length, questions, approvals, stalled },
    shippedToday,
    epics,
    counts: boardCounts(state),
    nextInLine,
    labels,
    cards,
    activity,
  };
}
