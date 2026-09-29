/** @typedef {import('./reduce.js').Task} Task */
/** @typedef {'backlog' | 'ready' | 'in_progress' | 'blocked' | 'done'} Column */

/** Display order, left to right (§5). */
export const COLUMNS = Object.freeze(/** @type {Column[]} */ (['backlog', 'ready', 'in_progress', 'blocked', 'done']));
export const COLUMN_LABELS = Object.freeze({ backlog: 'Backlog', ready: 'Ready', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' });

/** A task by id; never matches inherited keys such as "__proto__". */
const taskOf = (tasks, id) => (Object.hasOwn(tasks, id) ? tasks[id] : undefined);

/**
 * What currently blocks a task: its open dependencies (each id once) then its open questions.
 * Deliberate choices: a dependency on a task that does not exist counts as satisfied (it is
 * not listed), and the task's own column is ignored (a done task still lists its open
 * dependencies; callers decide whether to show them).
 * @param {Task} task
 * @param {Record<number, Task>} tasks
 * @returns {({ type: 'dependency', id: number } | { type: 'question', id: string, to: string })[]}
 */
export function blockers(task, tasks) {
  const out = [];
  const seen = new Set();
  for (const id of task.dependsOn) {
    if (seen.has(id)) continue;
    seen.add(id);
    const dep = taskOf(tasks, id);
    if (dep && !dep.done) out.push({ type: 'dependency', id });
  }
  for (const q of task.openQuestions) out.push({ type: 'question', id: q.id, to: q.to });
  return out;
}

/**
 * True when an existing, unfinished dependency or an open question blocks the task
 * (same rule as `blockers(...).length > 0`, but stops at the first hit).
 * @param {Task} task
 * @param {Record<number, Task>} tasks
 * @returns {boolean}
 */
export function isBlocked(task, tasks) {
  if (task.openQuestions.length > 0) return true;
  for (const id of task.dependsOn) {
    const dep = taskOf(tasks, id);
    if (dep && !dep.done) return true;
  }
  return false;
}

/**
 * Rule order from §5; the first match wins. Epics have no column. Done beats Blocked:
 * a finished task is 'done' even with open dependencies or questions.
 * @param {Task} task
 * @param {Record<number, Task>} tasks
 * @returns {Column | null}
 */
export function columnOf(task, tasks) {
  if (task.kind === 'epic') return null;
  if (task.done) return 'done';
  if (!task.approved) return 'backlog';
  if (isBlocked(task, tasks)) return 'blocked';
  if (task.assignee != null && task.assignee !== '') return 'in_progress';
  return 'ready';
}

/**
 * Index of children by parent id, built in one O(n) pass.
 * @param {Record<number, Task>} tasks
 * @returns {Map<number | string, Task[]>}
 */
export function childrenIndex(tasks) {
  const index = new Map();
  for (const t of Object.values(tasks)) {
    if (t.parent == null) continue;
    const list = index.get(t.parent);
    if (list) list.push(t);
    else index.set(t.parent, [t]);
  }
  return index;
}

/**
 * Tasks (kind 'task') anywhere under an epic, walking sub-epics at any depth.
 * Cycle-safe: each epic is visited once. Only epics are walked through.
 * @param {number} epicId
 * @param {Record<number, Task>} tasks
 * @param {Map<number | string, Task[]>} [children] a prebuilt childrenIndex(tasks)
 * @returns {Task[]}
 */
export function epicTasks(epicId, tasks, children = childrenIndex(tasks)) {
  const out = [];
  const visited = new Set([epicId]);
  const queue = [epicId];
  for (let i = 0; i < queue.length; i++) {
    for (const child of children.get(queue[i]) ?? []) {
      if (child.kind === 'task') out.push(child);
      else if (child.kind === 'epic' && !visited.has(child.id)) {
        visited.add(child.id);
        queue.push(child.id);
      }
    }
  }
  return out;
}

/**
 * Done/total counts of the tasks under an epic (see epicTasks).
 * @param {number} epicId
 * @param {Record<number, Task>} tasks
 * @param {Map<number | string, Task[]>} [children] a prebuilt childrenIndex(tasks)
 * @returns {{ done: number, total: number }}
 */
export function epicProgress(epicId, tasks, children) {
  const list = epicTasks(epicId, tasks, children);
  return { done: list.filter((t) => t.done).length, total: list.length };
}

/**
 * "Epic › Sub-epic" for a task, or '' when it has no epic. Walks up through epic parents
 * only, at any depth; each epic appears once, so parent cycles terminate.
 * @param {Task} task
 * @param {Record<number, Task>} tasks
 * @returns {string}
 */
export function epicPath(task, tasks) {
  const names = [];
  const visited = new Set();
  let parent = task.parent != null ? taskOf(tasks, task.parent) : undefined;
  while (parent && parent.kind === 'epic' && !visited.has(parent)) {
    visited.add(parent);
    names.unshift(parent.title);
    parent = parent.parent != null ? taskOf(tasks, parent.parent) : undefined;
  }
  return names.join(' › ');
}

/**
 * Is the task under the epic, at any depth (through epics only, cycle-safe)?
 * @param {Task} task
 * @param {number} epicId
 * @param {Record<number, Task>} tasks
 * @returns {boolean}
 */
export function inEpic(task, epicId, tasks) {
  const visited = new Set();
  let id = task.parent;
  while (id != null && !visited.has(id)) {
    if (id === epicId) return true;
    visited.add(id);
    const p = taskOf(tasks, id);
    if (!p || p.kind !== 'epic') return false;
    id = p.parent;
  }
  return false;
}

/**
 * Sort comparator: rank, then id.
 * @param {Task} a
 * @param {Task} b
 * @returns {number}
 */
export function byRank(a, b) {
  return a.rank - b.rank || a.id - b.id;
}

/**
 * Tasks in the 'ready' column, in rank order.
 * @param {Record<number, Task>} tasks
 * @returns {Task[]}
 */
export function readyQueue(tasks) {
  return Object.values(tasks).filter((t) => columnOf(t, tasks) === 'ready').sort(byRank);
}

/**
 * Would "from depends on to" close a cycle?
 * @param {Record<number, Task>} tasks
 * @param {number} from
 * @param {number} to
 * @returns {boolean}
 */
export function wouldCycle(tasks, from, to) {
  const seen = new Set();
  const stack = [to];
  while (stack.length) {
    const id = stack.pop();
    if (id === from) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const t = taskOf(tasks, id);
    if (t) for (const d of t.dependsOn) stack.push(d);
  }
  return false;
}
