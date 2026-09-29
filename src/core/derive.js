/** @typedef {import('./reduce.js').Task} Task */
/** @typedef {'backlog' | 'ready' | 'in_progress' | 'blocked' | 'done'} Column */

/** Display order, left to right (§5). */
export const COLUMNS = /** @type {Column[]} */ (['backlog', 'ready', 'in_progress', 'blocked', 'done']);
export const COLUMN_LABELS = { backlog: 'Backlog', ready: 'Ready', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' };

/** A task by id; never matches inherited keys such as "__proto__". */
const taskOf = (tasks, id) => (Object.hasOwn(tasks, id) ? tasks[id] : undefined);

/** @param {Task} task @param {Record<number, Task>} tasks */
export function blockers(task, tasks) {
  const out = [];
  for (const id of task.dependsOn) {
    const dep = taskOf(tasks, id);
    if (dep && !dep.done) out.push({ type: 'dependency', id });
  }
  for (const q of task.openQuestions) out.push({ type: 'question', id: q.id, to: q.to });
  return out;
}

/** Rule order from §5; the first match wins. Epics have no column. @returns {Column | null} */
export function columnOf(task, tasks) {
  if (task.kind === 'epic') return null;
  if (task.done) return 'done';
  if (!task.approved) return 'backlog';
  if (blockers(task, tasks).length > 0) return 'blocked';
  if (task.assignee) return 'in_progress';
  return 'ready';
}

/** Tasks under an epic, including tasks of its sub-epics. */
export function epicTasks(epicId, tasks) {
  const all = Object.values(tasks);
  const subEpics = new Set(all.filter((t) => t.kind === 'epic' && t.parent === epicId).map((t) => t.id));
  return all.filter((t) => t.kind === 'task' && (t.parent === epicId || subEpics.has(t.parent)));
}

export function epicProgress(epicId, tasks) {
  const list = epicTasks(epicId, tasks);
  return { done: list.filter((t) => t.done).length, total: list.length };
}

/** "Epic › Sub-epic" for a task, or '' when it has no epic. */
export function epicPath(task, tasks) {
  const names = [];
  let parent = task.parent != null ? taskOf(tasks, task.parent) : undefined;
  while (parent && names.length < 3) {
    names.unshift(parent.title);
    parent = parent.parent != null ? taskOf(tasks, parent.parent) : undefined;
  }
  return names.join(' › ');
}

export function byRank(a, b) {
  return a.rank - b.rank || a.id - b.id;
}

export function readyQueue(tasks) {
  return Object.values(tasks).filter((t) => columnOf(t, tasks) === 'ready').sort(byRank);
}

/** Would "from depends on to" close a cycle? */
export function wouldCycle(tasks, from, to) {
  const seen = new Set();
  const stack = [to];
  while (stack.length) {
    const id = stack.pop();
    if (id === from) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const t = taskOf(tasks, id);
    if (t) stack.push(...t.dependsOn);
  }
  return false;
}
